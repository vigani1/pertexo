import type { AccessibleWorkspace } from '@pertexo/contracts';
import { screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import {
  createUserFixture,
  createWorkspaceFixture,
} from '../../../support/fixtures/identity';
import { mockServer } from '../../../support/mock-server';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const importId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const billingId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const runId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const timestamp = '2026-09-15T10:00:00.000Z';

export const api = `http://pertexo.test/v1/workspaces/${workspaceId}`;

export const user = createUserFixture({
  id: userId,
  displayName: 'Workspace Operator',
  createdAt: timestamp,
  updatedAt: timestamp,
});

export function workspace(
  capabilities: Readonly<AccessibleWorkspace['capabilities']>,
) {
  return createWorkspaceFixture({
    id: workspaceId,
    role: 'operator',
    capabilities: ['workspace:read', 'workflow:read', ...capabilities],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function thread(
  workflowId: string,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    id: workflowId,
    noticeKind: 'workflow_failure' as const,
    workflowId,
    workflowName: workflowId === importId ? 'Nightly import' : 'Billing sync',
    kind: 'failed',
    failureDays: [],
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

function hintStream() {
  const encoder = new TextEncoder();
  let push: (text: string) => void = () => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (text) => {
        controller.enqueue(encoder.encode(text));
      };
      push('event: inbox.ready\ndata: {"revision":null}\n\n');
    },
  });
  return {
    response: () =>
      new HttpResponse(body, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    changed: (revision: string) => {
      push(`event: inbox.changed\ndata: {"revision":"${revision}"}\n\n`);
    },
  };
}

export function inboxApi(state: {
  threads: ReturnType<typeof thread>[];
  revision: string;
}) {
  const reads: unknown[] = [];
  const readAlls: unknown[] = [];
  const unreadLists = { count: 0 };
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
      if (filter === 'unread') unreadLists.count += 1;
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
          threadId: params.workflowId,
          unread: false,
          revision: state.revision,
        });
      },
    ),
  );
  return { reads, readAlls, unreadLists, stream };
}

export function spineInbox() {
  const [spine] = screen.getAllByRole('navigation', { name: 'Workspace' });
  if (spine === undefined) throw new Error('Expected the workspace spine');
  return within(spine);
}

export const failedStep = {
  nodeId: 'fetch',
  label: 'Fetch orders',
  definitionKey: 'core.http',
  safeErrorCode: null,
};
