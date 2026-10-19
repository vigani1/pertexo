import type { WorkflowRunReadSummary } from '@pertexo/contracts';
import { formatDateTime } from '@/lib/format/time';
import { admissionBlockerWords } from '../model/presentation/admission';

/**
 * Current server projection, not a promise of start time or a new run
 * status. In a list, `compact` keeps a row to the reason; the list says the
 * rest once.
 */
export function RunAdmissionBlockers({
  run,
  compact = false,
  className,
}: Readonly<{
  run: WorkflowRunReadSummary;
  compact?: boolean;
  className?: string;
}>) {
  if (
    run.status !== 'queued' ||
    run.admissionBlockers === undefined ||
    run.admissionBlockers.reasons.length === 0
  )
    return null;
  if (compact)
    return (
      <p className={className}>
        Waiting for {admissionBlockerWords(run.admissionBlockers.reasons)}
      </p>
    );
  return (
    <p className={className}>
      Waiting for {admissionBlockerWords(run.admissionBlockers.reasons)}.
      Observed{' '}
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
