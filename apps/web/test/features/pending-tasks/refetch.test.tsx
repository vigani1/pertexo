import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import {
  taskKeys,
  taskQueryOptions,
} from '@/features/pending-tasks/data/tasks.queries';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import {
  identityHandlers,
  ownerWorkspace,
  user,
  userId,
  workspaceId,
} from '../../support/fixtures/team';
const taskId = '11111111-1111-4111-8111-111111111111';
const base = `http://pertexo.test/v1/workspaces/${workspaceId}/pending-tasks`;
function summary() {
  return {
    id: taskId,
    workspaceId,
    workflowId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    workflowName: 'Payment review',
    runId: '33333333-3333-4333-8333-333333333333',
    nodeId: 'review',
    nodeRunId: '44444444-4444-4444-8444-444444444444',
    iterationPath: [],
    kind: 'approval',
    title: 'Review payment',
    details: { Amount: 120 },
    status: 'pending',
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    onExpiry: 'fail',
    completedAt: null,
    completedByName: null,
    canRespond: true,
    blockedReason: null,
  };
}
function detail(kind: 'approval' | 'input_request' = 'approval') {
  return {
    ...summary(),
    kind,
    workflowVersionId: '22222222-2222-4222-8222-222222222222',
    instructions: 'Check the amount.',
    audience: { roles: ['owner', 'admin'], memberIds: [] },
    output: null,
    ...(kind === 'input_request'
      ? {
          fields: [
            {
              id: 'reason',
              name: 'reason',
              label: 'Reason',
              type: 'text',
              required: true,
            },
          ],
          prefill: {},
        }
      : {}),
  };
}
it.each(['approval', 'input_request'] as const)(
  'keeps an unsaved %s response across a failed detail refresh',
  async (kind) => {
    let failing = false;
    const task = detail(kind);
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      http.get(base, () =>
        HttpResponse.json({ items: [], nextCursor: null, pendingCount: 0 }),
      ),
      http.get(`${base}/${taskId}`, () =>
        failing ? HttpResponse.error() : HttpResponse.json({ task }),
      ),
    );
    const app = renderApp(`/w/${workspaceId}/requests/${taskId}`);
    const scope = { apiClient: app.apiClient, userId, workspaceId };
    const actor = userEvent.setup();
    const label = kind === 'approval' ? 'Comment (optional)' : 'Reason';
    const field = await screen.findByLabelText(label);
    await actor.type(field, 'Do not lose this response');
    failing = true;
    await act(async () => {
      await app.queryClient.invalidateQueries({
        queryKey: taskQueryOptions(scope, taskId).queryKey,
      });
    });
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByLabelText(label)).toBe(field);
    expect(field).toHaveValue('Do not lose this response');
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t refresh');
    failing = false;
    await actor.click(retry);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    });
    expect(screen.getByLabelText(label)).toBe(field);
    expect(field).toHaveValue('Do not lose this response');
  },
);
it('keeps a pending list decision and its exact retry across a failed background read', async () => {
  let failing = false;
  const writes: { key: string | null; body: unknown }[] = [];
  const task = detail();
  const item = summary();
  mockServer.use(
    ...identityHandlers(ownerWorkspace),
    http.get(base, () =>
      failing
        ? HttpResponse.error()
        : HttpResponse.json({
            items: writes.length >= 2 ? [] : [item],
            nextCursor: null,
            pendingCount: writes.length >= 2 ? 0 : 1,
          }),
    ),
    http.post(`${base}/${taskId}/decide`, async ({ request }) => {
      writes.push({
        key: request.headers.get('idempotency-key'),
        body: await request.json(),
      });
      if (writes.length === 1) return HttpResponse.error();
      const decidedAt = new Date().toISOString();
      return HttpResponse.json({
        task: {
          ...task,
          status: 'approved',
          completedAt: decidedAt,
          completedByName: user.displayName,
          canRespond: false,
          blockedReason: 'resolved',
          output: {
            decision: 'approved',
            comment: '',
            decidedBy: userId,
            decidedAt,
          },
        },
        replayed: true,
      });
    }),
  );
  const app = renderApp(`/w/${workspaceId}/requests`);
  const actor = userEvent.setup();
  await actor.click(
    await screen.findByRole('button', { name: 'Approve Review payment' }),
  );
  const decisionRetry = await screen.findByRole('button', {
    name: 'Retry same decision',
  });
  failing = true;
  await act(async () => {
    await app.queryClient.invalidateQueries({
      queryKey: taskKeys.scope(userId, workspaceId),
    });
  });
  const retryRead = await screen.findByRole('button', { name: 'Retry' });
  expect(screen.queryByRole('button', { name: 'Retry same decision' })).toBe(
    decisionRetry,
  );
  failing = false;
  await actor.click(retryRead);
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
  await actor.click(decisionRetry);
  await waitFor(() => {
    expect(writes).toHaveLength(2);
  });
  expect(writes[1]).toEqual(writes[0]);
});
