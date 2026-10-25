import {
  workflowErrorInputSchema,
  type WorkflowErrorInput,
} from '@pertexo/workflow-model';
import type { WorkflowTransitionPlan as RunTransitionPlan } from '../types.js';

export function errorWorkflowFailure(plan: RunTransitionPlan) {
  const status = plan.checkpoint.runStatus;
  const failures = plan.checkpoint.invocations.filter(
    (invocation) =>
      invocation.status === status &&
      invocation.failureHandling?.disposition !== 'handled',
  );
  // A failed handler explains settlement ahead of the source it could not handle.
  return (
    failures.find((invocation) => invocation.failureHandling === undefined) ??
    failures[0]
  );
}

/** Deliberately never accepts an executor error message or run values. */
export function errorWorkflowInput(
  input: Readonly<{
    workspaceId: string;
    workflowId: string;
    workflowName: string;
    workflowVersionId: string;
    runId: string;
    plan: RunTransitionPlan;
    step?: Omit<NonNullable<WorkflowErrorInput['failedStep']>, 'id'>;
  }>,
): WorkflowErrorInput {
  const status = input.plan.checkpoint.runStatus;
  const failed = errorWorkflowFailure(input.plan);
  const error = safeRunFailureSummary(status);
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
    failedStep:
      failed === undefined ? null : { id: failed.nodeId, ...input.step },
    error,
  });
}

function safeRunFailureSummary(
  status: RunTransitionPlan['checkpoint']['runStatus'],
): WorkflowErrorInput['error'] {
  if (status === 'outcome_unknown') {
    return {
      code: 'execution.outcome_unknown',
      message:
        'A step may have taken effect. Check the service before repeating it.',
    };
  }
  if (status === 'timed_out') {
    return {
      code: 'execution.timed_out',
      message: 'The workflow exceeded its deadline.',
    };
  }
  return { code: 'execution.failed', message: 'The workflow failed.' };
}
