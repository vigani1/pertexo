import type { WorkflowRunReadSummary } from '@pertexo/contracts';
import { formatDateTime } from '@/lib/format/time';

const reasons = {
  workspace_capacity: 'workspace capacity',
  workflow_capacity: 'workflow concurrency capacity',
  workflow_order: 'an earlier accepted run to start',
} as const;

/** Current server projection, not a promise of start time or a new run status. */
export function RunAdmissionBlockers({
  run,
  className,
}: Readonly<{ run: WorkflowRunReadSummary; className?: string }>) {
  if (
    run.status !== 'queued' ||
    run.admissionBlockers === undefined ||
    run.admissionBlockers.reasons.length === 0
  )
    return null;
  return (
    <p className={className}>
      Waiting for{' '}
      {run.admissionBlockers.reasons
        .map((reason) => reasons[reason])
        .join(', ')}
      . Observed{' '}
      <time
        dateTime={run.admissionBlockers.asOf}
        title={run.admissionBlockers.asOf}
      >
        {formatDateTime(run.admissionBlockers.asOf)}
      </time>
      ; the queue can change.
    </p>
  );
}
