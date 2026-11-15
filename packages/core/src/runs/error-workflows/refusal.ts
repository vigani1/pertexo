import type { WorkflowTransitionPlan } from '@pertexo/workflow-engine';
import { CallableInputInvalidError } from '@pertexo/workflow-model';
import {
  WorkflowAlreadyRunningError,
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from '../commands/acceptance/run-admission.errors.js';
import { ErrorWorkflowVersionUnavailableError } from './error-workflow.errors.js';
import type { ErrorWorkflowRefusalCode } from './intents.repository.js';

/** The refusal an admission failure leaves on the intent, or undefined to rethrow. */
export function errorWorkflowRefusal(
  error: unknown,
): ErrorWorkflowRefusalCode | undefined {
  if (error instanceof WorkflowAlreadyRunningError) return 'concurrency_limit';
  if (error instanceof WorkspaceRunQuotaExceededError) return 'queue_full';
  if (error instanceof WorkspaceRunAdmissionDeniedError)
    return 'workspace_unavailable';
  if (
    error instanceof ErrorWorkflowVersionUnavailableError ||
    error instanceof CallableInputInvalidError
  )
    return 'invalid_target';
  return undefined;
}

const ERROR_WORKFLOW_RUN_EVENTS: ReadonlySet<string> = new Set([
  'run.failed',
  'run.timed_out',
  'run.outcome_unknown',
]);

/** A run that fails, times out or ends unknown starts its error workflow, unless it was cancelled. */
export function transitionStartsErrorWorkflow(
  input: Readonly<{
    cancellationRequested: boolean;
    plan: Pick<WorkflowTransitionPlan, 'events'>;
  }>,
): boolean {
  return (
    !input.cancellationRequested &&
    input.plan.events.some((event) => ERROR_WORKFLOW_RUN_EVENTS.has(event.name))
  );
}
