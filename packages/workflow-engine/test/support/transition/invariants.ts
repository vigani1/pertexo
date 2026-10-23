import {
  advanceWorkflow,
  createCheckpoint,
  invocationKey,
  type WorkflowCheckpoint,
  type WorkflowObservation,
} from '../engine.js';

export const occurredAt = '2026-08-20T10:00:00.000Z';
export const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
export const inline = (attemptId: string) => ({
  kind: 'inline' as const,
  attemptId,
});
export function advance(
  checkpoint: WorkflowCheckpoint,
  observations: readonly WorkflowObservation[],
  dueResumptions?: readonly Readonly<{
    invocationKey: string;
    occurredAt: string;
  }>[],
) {
  return advanceWorkflow({
    checkpoint,
    observations,
    occurredAt,
    maximumAdmissions: 0,
    ...(dueResumptions === undefined ? {} : { dueResumptions }),
  });
}
export const workflowVersionId = '00000000-0000-4000-8000-000000000001';
export const rootKey = (nodeId: string) =>
  invocationKey({ workflowVersionId, nodeId });
export const loopBody = {
  branchPath: [],
  iterationPath: [],
  bodyRootNodeIds: ['body'],
  bodySinkNodeId: 'body',
} as const;
export function checkpoint(): ReturnType<typeof createCheckpoint> {
  return createCheckpoint({
    workflowVersionId,
    iterationBudget: 100,
  });
}
