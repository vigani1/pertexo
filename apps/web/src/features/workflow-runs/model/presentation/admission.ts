import type { WorkflowRunReadSummary } from '@pertexo/contracts';

type BlockerReason = NonNullable<
  WorkflowRunReadSummary['admissionBlockers']
>['reasons'][number];

const reasons: Readonly<Record<BlockerReason, string>> = {
  workspace_capacity: 'workspace capacity',
  workflow_capacity: 'workflow concurrency capacity',
  workflow_order: 'an earlier accepted run to start',
};

/** What queued runs are waiting for, in words, in a stable order. */
export function admissionBlockerWords(
  blockers: readonly BlockerReason[],
): string {
  return (Object.keys(reasons) as BlockerReason[])
    .filter((reason) => blockers.includes(reason))
    .map((reason) => reasons[reason])
    .join(', ');
}
