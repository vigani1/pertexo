import type { WorkflowSummary } from '@pertexo/contracts';

/** Keep field, dismissal and confirmation guards consistent for one reviewed run. */
export function runInputAvailability(
  input: Readonly<{
    pending: boolean;
    retryAvailable: boolean;
    publicationConflict: boolean;
    workflow: WorkflowSummary | undefined;
    cases: Readonly<{
      locked: boolean;
      editing: boolean;
      accessLost: boolean;
      stale: boolean;
    }>;
    review: Readonly<{ pending: boolean; waiting: boolean }>;
  }>,
) {
  const locked = input.pending || input.cases.locked || input.review.pending;
  const publicationUnavailable =
    input.workflow !== undefined &&
    (input.workflow.publishedVersionId === null ||
      input.workflow.lifecycleStatus !== 'active');
  return {
    locked,
    fieldsBlocked: locked || input.retryAvailable || input.review.waiting,
    confirmDisabled:
      input.cases.locked ||
      input.cases.editing ||
      input.cases.accessLost ||
      input.publicationConflict ||
      input.review.pending ||
      input.review.waiting ||
      (!input.retryAvailable && (input.cases.stale || publicationUnavailable)),
  };
}
