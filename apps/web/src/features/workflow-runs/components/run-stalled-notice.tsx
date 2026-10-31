import type { WorkflowRunReadSummary } from '@pertexo/contracts';
import { Notice } from '@/components/ui/notice';
import { formatDateTime } from '@/lib/format/time';

/**
 * A run shown as running while nothing is acting on it would read as progress.
 * This goes by itself as soon as a worker picks the run up again.
 */
export function RunStalledNotice({
  run,
  className,
}: Readonly<{ run: WorkflowRunReadSummary; className?: string }>) {
  if (run.stalled === undefined) return null;
  return (
    <Notice tone="warning" className={className}>
      This run has stalled: nothing has acted on it since{' '}
      <time dateTime={run.stalled.since} title={run.stalled.since}>
        {formatDateTime(run.stalled.since)}
      </time>
      . It continues by itself once a worker is running again, without repeating
      a step that may already have reached another service.
    </Notice>
  );
}
