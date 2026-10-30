import userEvent from '@testing-library/user-event';
import { act, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  WorkflowPresenceProvider,
  WorkflowPresenceSummary,
  WorkflowPresenceWarning,
  WorkflowEditingPresence,
} from '@/features/workflow-collaboration/presence.public';
import { createEditorStore } from '@/features/workflow-editor/model/state/store';
import { editorPresenceSource } from '@/features/workflow-editor/model/state/presence';
import { createApiClient } from '@/lib/api/client';
import { renderInRouter } from '../../support/render-in-router';
import {
  userId,
  workspaceId,
  workflowId,
  emptyGraph,
} from '../../support/fixtures/workflow-editor';
it('projects only editor metadata, warns about other dirty tabs, and renews with increasing sequence numbers', async () => {
  const writes: Record<string, unknown>[] = [];
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation((_input, init) => {
      if (init?.method === 'PUT') {
        writes.push(
          JSON.parse(
            typeof init.body === 'string' ? init.body : 'null',
          ) as Record<string, unknown>,
        );
        return Promise.resolve(
          new Response(JSON.stringify({ accepted: true }), {
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            people: [
              {
                userId,
                displayName: 'Ada in another tab',
                editing: true,
                dirty: true,
                baseRevision: 1,
                tabCount: 1,
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );
    });
  const scope = {
    apiClient: createApiClient({
      fetch,
      readCsrfToken: () =>
        'csrf-token-for-component-tests-12345678901234567890',
    }),
    userId,
    workspaceId,
    workflowId,
  };
  const store = createEditorStore({
    graph: emptyGraph,
    etag: '"draft"',
    revision: 1,
  });
  const source = editorPresenceSource({ store, editing: true });
  renderInRouter(
    <WorkflowPresenceProvider scope={scope}>
      <WorkflowEditingPresence source={source} />
      <WorkflowPresenceSummary />
      <WorkflowPresenceWarning />
    </WorkflowPresenceProvider>,
  );
  await screen.findByText('Unsaved changes in another tab.');
  await waitFor(() => {
    expect(writes.length).toBeGreaterThan(0);
  });
  act(() => {
    store.getState().setInspectorScratch(true);
  });
  await waitFor(() => {
    expect(writes.at(-1)).toMatchObject({
      editing: true,
      dirty: true,
      baseRevision: 1,
    });
  });
  expect(
    writes.every(
      (body) =>
        Object.keys(body).sort().join(',') ===
        'baseRevision,dirty,editing,sequence',
    ),
  ).toBe(true);
  const numbers = writes.map((body) => Number(body.sequence));
  expect(numbers).toEqual([...new Set(numbers)].sort((a, b) => a - b));
});

it('keeps presence failures advisory with a compact accessible explanation', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValue(new TypeError('Offline'));
  const scope = {
    apiClient: createApiClient({
      fetch,
      readCsrfToken: () =>
        'csrf-token-for-component-tests-12345678901234567890',
    }),
    userId,
    workspaceId,
    workflowId,
  };
  renderInRouter(
    <WorkflowPresenceProvider scope={scope}>
      <WorkflowPresenceSummary />
    </WorkflowPresenceProvider>,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', { name: 'Presence unavailable' }),
  );
  await screen.findByText(
    'You can edit and save normally. Presence will retry automatically.',
  );
});

it('names other people as beads and keeps your own other tab separate', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation((_input, init) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            init?.method === 'PUT'
              ? { accepted: true }
              : {
                  people: [
                    {
                      userId: '7a1e7a1e-7a1e-4a1e-8a1e-7a1e7a1e7a1e',
                      displayName: 'Grace Hopper',
                      editing: true,
                      dirty: false,
                      baseRevision: 1,
                      tabCount: 1,
                    },
                    {
                      userId,
                      displayName: 'You elsewhere',
                      editing: false,
                      dirty: false,
                      baseRevision: null,
                      tabCount: 2,
                    },
                  ],
                },
          ),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
  const scope = {
    apiClient: createApiClient({
      fetch,
      readCsrfToken: () =>
        'csrf-token-for-component-tests-12345678901234567890',
    }),
    userId,
    workspaceId,
    workflowId,
  };
  renderInRouter(
    <WorkflowPresenceProvider scope={scope}>
      <WorkflowPresenceSummary />
    </WorkflowPresenceProvider>,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', { name: 'Here with you: Grace Hopper' }),
  );
  expect(await screen.findByText('Grace Hopper')).toBeVisible();
  expect(screen.getByText('Editing')).toBeVisible();
  expect(
    screen.getByText('You also have this workflow open in 2 other tabs.'),
  ).toBeVisible();
  expect(screen.queryByText('You elsewhere')).not.toBeInTheDocument();
});

it('reuses the current tab lease and increases its sequence after route remount', async () => {
  const leases = new Set<string>();
  const sequences: number[] = [];
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation((input, init) => {
      let url: string;
      if (typeof input === 'string') url = input;
      else if (input instanceof URL) url = input.href;
      else url = input.url;
      if (init?.method === 'PUT') {
        leases.add(url.split('/').at(-1) ?? '');
        const body = JSON.parse(
          typeof init.body === 'string' ? init.body : 'null',
        ) as { sequence: number };
        sequences.push(body.sequence);
        return Promise.resolve(Response.json({ accepted: true }));
      }
      const current = new URL(url).searchParams.get('tabId');
      return Promise.resolve(
        Response.json({
          people: [...leases]
            .filter((id) => id !== current)
            .map(() => ({
              userId,
              displayName: 'You',
              editing: false,
              dirty: false,
              baseRevision: null,
              tabCount: 1,
            })),
        }),
      );
    });
  const scope = {
    apiClient: createApiClient({
      fetch,
      readCsrfToken: () =>
        'csrf-token-for-component-tests-12345678901234567890',
    }),
    userId,
    workspaceId,
    workflowId,
  };
  const content = (
    <WorkflowPresenceProvider scope={scope}>
      <WorkflowPresenceSummary />
    </WorkflowPresenceProvider>
  );
  const first = renderInRouter(content);
  await waitFor(() => {
    expect(sequences.length).toBeGreaterThan(0);
  });
  first.unmount();
  const count = sequences.length;
  renderInRouter(content);
  await waitFor(() => {
    expect(sequences.length).toBeGreaterThan(count);
  });
  expect(leases.size).toBe(1);
  expect(sequences.at(-1)).toBeGreaterThan(sequences[0] ?? 0);
  expect(screen.queryByText('Also in another tab')).not.toBeInTheDocument();
});

it('shows who is here without announcing anything while paused', async () => {
  const methods: (string | undefined)[] = [];
  const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    methods.push(init?.method);
    return Promise.resolve(
      new Response(JSON.stringify({ items: [], serverTime: new Date(0) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  const scope = {
    apiClient: createApiClient({
      fetch,
      readCsrfToken: () =>
        'csrf-token-for-component-tests-12345678901234567890',
    }),
    userId,
    workspaceId,
    workflowId,
  };
  renderInRouter(
    <WorkflowPresenceProvider scope={scope} paused>
      <span>Page</span>
    </WorkflowPresenceProvider>,
  );

  await screen.findByText('Page');
  expect(methods).not.toContain('PUT');
});
