import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const importId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const billingId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const runId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const timestamp = '2026-09-15T10:00:00.000Z';
const api = `http://pertexo.test/v1/workspaces/${workspaceId}`;
const user = {
  id: userId,
  email: 'operator@example.test',
  displayName: 'Workspace Operator',
  status: 'active',
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function workspace(capabilities: readonly string[]) {
  return {
    id: workspaceId,
    name: 'Control Operations',
    slug: 'control-operations',
    status: 'active',
    revision: 1,
    role: 'operator',
    capabilities: ['workspace:read', 'workflow:read', ...capabilities],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function thread(
  workflowId: string,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    workflowId,
    workflowName: workflowId === importId ? 'Nightly import' : 'Billing sync',
    kind: 'failed',
    occurrenceCount: 1,
    firstOccurredAt: '2026-09-15T09:00:00.000000Z',
    latestOccurredAt: '2026-09-15T09:30:00.000000Z',
    latestRunId: runId,
    latestFailedStep: null,
    revision: '7',
    unread: true,
    ...overrides,
  };
}

/** A hint stream the test can push to while the page is open. */
function hintStream() {
  const encoder = new TextEncoder();
  let push: (text: string) => void = () => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (text) => {
        controller.enqueue(encoder.encode(text));
      };
      push('event: inbox.ready\ndata: {"schemaVersion":1,"revision":null}\n\n');
    },
  });
  return {
    response: () =>
      new HttpResponse(body, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    changed: (revision: string) => {
      push(
        `event: inbox.changed\ndata: {"schemaVersion":1,"revision":"${revision}"}\n\n`,
      );
    },
  };
}

/** The API as one operator sees it; `state` changes as the test goes. */
function inboxApi(state: {
  threads: ReturnType<typeof thread>[];
  revision: string;
}) {
  const reads: unknown[] = [];
  const readAlls: unknown[] = [];
  const stream = hintStream();
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({
        items: [workspace(['notification:read'])],
        nextCursor: null,
      }),
    ),
    http.get(`${api}/notifications/summary`, () =>
      HttpResponse.json({
        unreadCount: state.threads.filter((item) => item.unread).length,
        revision: state.revision,
      }),
    ),
    http.get(`${api}/notifications/events`, () => stream.response()),
    http.get(`${api}/notifications`, ({ request }) => {
      const filter = new URL(request.url).searchParams.get('filter');
      return HttpResponse.json({
        items: state.threads.filter(
          (item) => filter !== 'unread' || item.unread,
        ),
        nextCursor: null,
        revision: state.revision,
      });
    }),
    http.post(`${api}/notifications/read-all`, async ({ request }) => {
      readAlls.push(await request.json());
      state.threads = state.threads.map((item) => ({ ...item, unread: false }));
      return HttpResponse.json({ marked: 2 });
    }),
    http.post(
      `${api}/notifications/:workflowId/read`,
      async ({ params, request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        reads.push({ workflowId: params.workflowId, ...body });
        state.threads = state.threads.map((item) =>
          item.workflowId === params.workflowId
            ? { ...item, unread: false }
            : item,
        );
        return HttpResponse.json({
          workflowId: params.workflowId,
          unread: false,
          revision: state.revision,
        });
      },
    ),
  );
  return { reads, readAlls, stream };
}

function spineInbox() {
  const [spine] = screen.getAllByRole('navigation', { name: 'Workspace' });
  if (spine === undefined) throw new Error('Expected the workspace spine');
  return within(spine);
}

describe('workspace inbox', () => {
  it('lists failing workflows with how often and where they failed', async () => {
    inboxApi({
      threads: [
        thread(importId, {
          kind: 'timed_out',
          occurrenceCount: 3,
          latestFailedStep: {
            nodeId: 'fetch',
            label: 'Fetch orders',
            definitionKey: 'core.http',
            safeErrorCode: null,
          },
        }),
        thread(billingId, { unread: false }),
      ],
      revision: '7',
    });
    renderApp(`/w/${workspaceId}/inbox`);

    const list = await screen.findByRole('list', { name: 'Failing workflows' });
    const [first, second, ...rest] = within(list).getAllByRole('listitem');
    if (first === undefined || second === undefined)
      throw new Error('Expected two notices');
    expect(rest).toEqual([]);
    expect(
      within(first).getByRole('link', { name: 'Nightly import, unread' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/runs/${runId}`);
    expect(within(first).getByText('Timed out')).toBeVisible();
    expect(first).toHaveTextContent('Failed 3 times since');
    expect(first).toHaveTextContent('at Fetch orders');
    expect(
      within(second).getByRole('link', { name: 'Billing sync' }),
    ).toBeVisible();
    expect(
      within(second).queryByRole('button', { name: /Mark .* read/u }),
    ).toBeNull();
    await waitFor(() => {
      expect(
        spineInbox().getByRole('link', { name: 'Inbox, 1 unread' }),
      ).toBeVisible();
    });
  });

  it('marks one notice read with the revision it showed', async () => {
    const actor = userEvent.setup();
    const { reads } = inboxApi({
      threads: [thread(importId), thread(billingId)],
      revision: '7',
    });
    renderApp(`/w/${workspaceId}/inbox`);

    await actor.click(
      await screen.findByRole('button', { name: 'Mark Nightly import read' }),
    );
    await waitFor(() => {
      expect(reads).toEqual([{ workflowId: importId, revision: '7' }]);
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Mark Nightly import read' }),
      ).toBeNull();
    });
    await waitFor(() => {
      expect(
        spineInbox().getByRole('link', { name: 'Inbox, 1 unread' }),
      ).toBeVisible();
    });
  });

  it('marks all read only up to what the list showed', async () => {
    const actor = userEvent.setup();
    const { readAlls } = inboxApi({
      threads: [thread(importId), thread(billingId)],
      revision: '9',
    });
    renderApp(`/w/${workspaceId}/inbox?filter=unread`);

    await screen.findByRole('link', { name: 'Nightly import, unread' });
    await actor.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => {
      expect(readAlls).toEqual([{ revision: '9' }]);
    });
    expect(
      await screen.findByRole('heading', { name: 'You’re caught up' }),
    ).toBeVisible();
  });

  it('refreshes when the workspace reports a new failure', async () => {
    const state = {
      threads: [thread(importId, { unread: false })],
      revision: '7',
    };
    const { stream } = inboxApi(state);
    renderApp(`/w/${workspaceId}/inbox`);

    await screen.findByRole('link', { name: 'Nightly import' });
    state.threads = [
      thread(billingId, { revision: '8' }),
      thread(importId, { unread: false }),
    ];
    state.revision = '8';
    stream.changed('8');
    expect(
      await screen.findByRole('link', { name: 'Billing sync, unread' }),
    ).toBeVisible();
    await waitFor(() => {
      expect(
        spineInbox().getByRole('link', { name: 'Inbox, 1 unread' }),
      ).toBeVisible();
    });
  });

  it('hides the inbox from a role without it', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({
          items: [{ ...workspace([]), role: 'builder' }],
          nextCursor: null,
        }),
      ),
    );
    renderApp(`/w/${workspaceId}/inbox`);

    expect(
      await screen.findByRole('heading', { name: 'The inbox is unavailable' }),
    ).toBeVisible();
    expect(spineInbox().queryByRole('link', { name: /Inbox/u })).toBeNull();
  });
});
