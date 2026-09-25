import { Status, type StatusTone } from '@/components/ui/status';
import type { RunStatistics } from '../workflow-runs.queries';

/** One exact count in a page header's mono line, e.g. "3 running". */
export function RunCount({
  tone,
  count,
  label,
}: Readonly<{ tone: StatusTone; count: number; label: string }>) {
  return (
    <Status tone={tone} className="font-mono text-xs font-normal">
      <span className="text-subtle-foreground">
        <b className="font-medium text-foreground">{String(count)}</b> {label}
      </span>
    </Status>
  );
}

/** Running, waiting and queued runs right now, for the Home and Runs headers. */
export function LiveRunCounts({
  current,
}: Readonly<{ current: RunStatistics['current'] }>) {
  return (
    <>
      <RunCount tone="live" count={current.running} label="running" />
      <RunCount tone="waiting" count={current.waiting} label="waiting" />
      <RunCount tone="queued" count={current.queued} label="queued" />
    </>
  );
}
