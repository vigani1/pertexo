import type {
  WorkflowGraphContract,
  WorkflowRunFailedStep,
  WorkflowRunResponse,
} from '@pertexo/contracts';
import { describeStep } from '@/features/catalog/presentation.public';
import { shortStepError } from './step-inspection/step-error-copy';

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
  const label = node?.label?.trim();
  const step =
    node === undefined
      ? undefined
      : label === undefined || label === ''
        ? describeStep(node.definition.key).name
        : label;
  const reason =
    failing.safeErrorCode === null
      ? failing.status === 'timed_out'
        ? 'timed out'
        : undefined
      : shortStepError(failing.safeErrorCode);
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
  const label = failedStep.label?.trim();
  const step =
    label !== undefined && label !== ''
      ? label
      : failedStep.definitionKey === null
        ? undefined
        : describeStep(failedStep.definitionKey).name;
  const reason =
    failedStep.safeErrorCode === null
      ? undefined
      : shortStepError(failedStep.safeErrorCode);
  return {
    ...(step === undefined ? {} : { step }),
    ...(reason === undefined ? {} : { reason }),
  };
}
