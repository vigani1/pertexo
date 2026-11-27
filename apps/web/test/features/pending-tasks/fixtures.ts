import { workspaceId } from '../../support/fixtures/team';

export const taskId = '11111111-1111-4111-8111-111111111111';
export const base = `http://pertexo.test/v1/workspaces/${workspaceId}/pending-tasks`;
export function summary() {
  return {
    id: taskId,
    workspaceId,
    workflowId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    workflowName: 'Payment review',
    runId: '33333333-3333-4333-8333-333333333333',
    nodeId: 'review',
    stepName: null,
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
export function detail(kind: 'approval' | 'input_request' = 'approval') {
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
