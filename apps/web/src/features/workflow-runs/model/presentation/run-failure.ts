import type {
  WorkflowGraphContract,
  WorkflowRunFailedStep,
  WorkflowRunResponse,
} from '@pertexo/contracts';
import { describeStep } from '@/features/catalog/presentation.public';
import { shortStepError } from '../step-inspection/step-error-copy';

const FAILED_STEP_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'timed_out',
  'outcome_unknown',
]);

export type RunFailure = Readonly<{ step?: string; reason?: string }>;

/**
 * Where and why a run went wrong, as far as its reads say: the last step
 * that failed, by its name (never its ID, so only when the version's graph
 * is known) and its error in a few words.
 */
export function describeRunFailure(
  snapshot: WorkflowRunResponse,
  graph: WorkflowGraphContract | undefined,
): RunFailure {
  const failing = snapshot.nodes
    .filter((node) => FAILED_STEP_STATUSES.has(node.status))
    .at(-1);
  if (failing === undefined) return {};
  const node = graph?.nodes.find(
    (candidate) => candidate.id === failing.nodeId,
  );
  const step = failureStepName(node?.label?.trim(), node?.definition.key);
  const reason = failureReason(failing.safeErrorCode, failing.status);
  return {
    ...(step === undefined ? {} : { step }),
    ...(reason === undefined ? {} : { reason }),
  };
}

/** The same, from the step a run list names for an unsuccessful run. */
export function describeListedFailure(
  failedStep: WorkflowRunFailedStep | null | undefined,
): RunFailure {
  if (failedStep === null || failedStep === undefined) return {};
  const step = failureStepName(
    failedStep.label?.trim(),
    failedStep.definitionKey,
  );
  const reason =
    failedStep.safeErrorCode === null
      ? undefined
      : shortStepError(failedStep.safeErrorCode);
  return {
    ...(step === undefined ? {} : { step }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function failureStepName(
  label: string | undefined,
  definitionKey: string | null | undefined,
): string | undefined {
  if (label !== undefined && label !== '') return label;
  if (definitionKey === null || definitionKey === undefined) return undefined;
  return describeStep(definitionKey).name;
}

function failureReason(
  code: string | null,
  status: string,
): string | undefined {
  if (code !== null) return shortStepError(code);
  return status === 'timed_out' ? 'timed out' : undefined;
}
