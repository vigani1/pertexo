import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { accessibleWorkspaceSchema } from '@pertexo/contracts';
import { workflowWorkspaceAccess } from '@/features/workflows/model/resource-access';
import { WorkflowReadBoundary } from '@/features/workflows/components/workflow-read-boundary';
import { workflowKeys } from '@/features/workflows/data/workflows.queries';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../../support/mock-server';
import { testFetch } from '../../../support/render-app';
import {
  api,
  userId,
  workspaceId,
  workflowId,
  workspaceWith,
  summary,
  problem,
} from '../list/fixtures';
const apiClient = createApiClient({
  fetch: testFetch,
  readCsrfToken: () => 'csrf-token-1234567890',
});
it('presents server-projected read-only actions without removing published-run capabilities or raising a role ceiling', () => {
  const workspace = accessibleWorkspaceSchema.parse(
    workspaceWith(['workflow:update', 'workflow:publish', 'run:start']),
  );
  const readOnly = workflowWorkspaceAccess(workspace, {
    canEdit: false,
    canPublish: false,
  });
  expect(readOnly.capabilities).toContain('run:start');
  expect(readOnly.capabilities).not.toContain('workflow:update');
  expect(readOnly.capabilities).not.toContain('workflow:publish');
  const viewer = accessibleWorkspaceSchema.parse({
    ...workspaceWith([]),
    role: 'viewer',
  });
  expect(
    workflowWorkspaceAccess(viewer, { canEdit: true, canPublish: true })
      .capabilities,
  ).toEqual(viewer.capabilities);
});
function MissingTarget() {
  const mutation = useMutation({
    mutationFn: () =>
      apiClient.request({
        path: `/v1/workspaces/${workspaceId}/connections/${workflowId}`,
        method: 'DELETE',
        response: { kind: 'empty' },
      }),
  });
  return (
    <button
      onClick={() => {
        mutation.mutate();
      }}
    >
      Missing connection
    </button>
  );
}
function setup() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const graphKey = [
    'identity',
    userId,
    'workspace',
    workspaceId,
    'workflow-editor',
    workflowId,
    'draft',
  ];
  cache.setQueryData(graphKey, { private: 'retained graph' });
  let reads = 0;
  mockServer.use(
    http.get(`${api}/workflows/${workflowId}`, () => {
      reads++;
      return HttpResponse.json({
        workflow: summary(workflowId, 'Private workflow'),
      });
    }),
    http.delete(`${api}/connections/${workflowId}`, () =>
      problem(404, 'resource.not_found'),
    ),
  );
  render(
    <QueryClientProvider client={cache}>
      <WorkflowReadBoundary
        apiClient={apiClient}
        userId={userId}
        workspaceId={workspaceId}
        workflowId={workflowId}
        fallback={<p>Workflow unavailable</p>}
      >
        <p>Workflow visible</p>
        <MissingTarget />
      </WorkflowReadBoundary>
    </QueryClientProvider>,
  );
  return { cache, graphKey, reads: () => reads };
}
it('unmounts a revoked workflow and clears cached graphs and collection snapshots after its own read refuses access', async () => {
  const f = setup();
  await waitFor(() => {
    expect(f.reads()).toBe(1);
  });
  mockServer.use(
    http.get(`${api}/workflows/${workflowId}`, () =>
      problem(404, 'resource.not_found'),
    ),
  );
  await act(async () => {
    await f.cache.invalidateQueries({
      queryKey: workflowKeys.detail(userId, workspaceId, workflowId),
    });
  });
  await screen.findByText('Workflow unavailable');
  await waitFor(() => {
    expect(f.cache.getQueryData(f.graphKey)).toBeUndefined();
  });
  expect(screen.queryByText('Workflow visible')).not.toBeInTheDocument();
});
it('rechecks the workflow after a missing mutation target and preserves access when its own read still succeeds', async () => {
  const f = setup();
  await waitFor(() => {
    expect(f.reads()).toBe(1);
  });
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Missing connection' }));
  await waitFor(() => {
    expect(f.reads()).toBeGreaterThan(1);
  });
  expect(screen.getByText('Workflow visible')).toBeInTheDocument();
  expect(f.cache.getQueryData(f.graphKey)).toEqual({
    private: 'retained graph',
  });
});
