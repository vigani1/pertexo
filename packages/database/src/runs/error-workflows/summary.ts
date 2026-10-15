import {
  workflowErrorInputSchema,
  type WorkflowErrorInput,
} from '@pertexo/workflow-model';
import type { RunTransitionPlan } from '../advance/plan.js';

/** Deliberately never accepts an executor error message or run values. */
export function errorWorkflowInput(
  input: Readonly<{
    workspaceId: string;
    workflowId: string;
    workflowName: string;
    workflowVersionId: string;
    runId: string;
    plan: RunTransitionPlan;
  }>,
): WorkflowErrorInput {
  const status = input.plan.checkpoint.runStatus;
  const failures = input.plan.checkpoint.invocations.filter(
    (invocation) =>
      invocation.status === status &&
      invocation.failureHandling?.disposition !== 'handled',
  );
  // A failed handler explains settlement ahead of the source it could not handle.
  const failed =
    failures.find((invocation) => invocation.failureHandling === undefined) ??
    failures[0];
  const error =
    status === 'outcome_unknown'
      ? {
          code: 'execution.outcome_unknown',
          message:
            'A step may have taken effect. Check the service before repeating it.',
        }
      : status === 'timed_out'
        ? {
            code: 'execution.timed_out',
            message: 'The workflow exceeded its deadline.',
          }
        : { code: 'execution.failed', message: 'The workflow failed.' };
  return workflowErrorInputSchema.parse({
    workflow: {
      id: input.workflowId,
      name: input.workflowName,
      versionId: input.workflowVersionId,
    },
    run: {
      id: input.runId,
      url: `/w/${input.workspaceId}/runs/${input.runId}`,
      status,
    },
    failedStep: failed === undefined ? null : { id: failed.nodeId },
    error,
  });
}
