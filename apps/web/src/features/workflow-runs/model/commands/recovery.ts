import {
  workflowRecoveryUnavailableProblemSchema,
  type WorkflowRecoveryPreview,
} from '@pertexo/contracts';
import { isUnconfirmedCommand } from '@/lib/api/commands/contract';
import { runAdmissionError } from './run';
import { isApiError } from '@/lib/api/error';
import { describeCommandError } from '@/lib/api/error-copy';
export type EligibleRecovery = Extract<
  WorkflowRecoveryPreview,
  { kind: 'eligible' }
>;
type Refusal = Extract<WorkflowRecoveryPreview, { kind: 'refused' }>['reason'];
const explanations: Readonly<Record<Refusal, string>> = {
  source_not_failed:
    'Only a failed or unknown-outcome run can use saved results.',
  multiple_failures:
    'More than one step failed. Use a full replay after reviewing its effects.',
  version_unavailable:
    'This run’s original version is unavailable or its workflow is archived.',
  unsupported_graph:
    'Saved-result recovery supports a single path with Condition and a final Stop run. It does not yet support joins, loops, Wait, Call workflow or failure links.',
  prefix_incomplete: 'Some earlier steps do not have complete saved results.',
  unknown_effect:
    'An earlier outcome is unknown. Check the service before starting a full replay.',
  effects_acknowledgement_required:
    'Confirm that this step may have partly taken effect before retrying it.',
  unknown_outcome_acknowledgement_required:
    'Confirm that this step may already have taken effect, even though its outcome is unknown, before retrying it.',
  evidence_unavailable:
    'This run’s execution evidence is incomplete. Saved results cannot safely be reused.',
  suffix_already_executed:
    'Later steps already ran. Review their effects before using a full replay.',
  values_expired:
    'This run’s saved results have expired. Use a full replay with reviewed input.',
  values_missing: 'Some saved results are no longer available.',
  artifact_value:
    'This run uses stored files. Saved-file recovery is not supported yet.',
  reuse_bounds: 'These saved results exceed the supported recovery size.',
  branch_evidence_unavailable:
    'An earlier Condition choice cannot be verified. Use a full replay after reviewing its effects.',
};
export function recoveryRefusal(reason: Refusal): string {
  return explanations[reason];
}
export function recoveryError(cause: unknown): string {
  const admissionError = runAdmissionError(cause);
  if (admissionError !== undefined) return admissionError;
  if (isUnconfirmedCommand(cause))
    return 'We couldn’t confirm whether the new run started. Retry the same request to check its acceptance; earlier steps will not run again.';
  if (isApiError(cause)) {
    const problem = workflowRecoveryUnavailableProblemSchema.safeParse(
      cause.problemDetails,
    );
    if (problem.success) return recoveryRefusal(problem.data.reason);
  }
  return describeCommandError(cause, 'retrying this step');
}
