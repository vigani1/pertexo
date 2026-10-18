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
  const source = editorPresenceSource(store, true);
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
