import { Status, type StatusTone } from '@/components/ui/status';
import { countLabel } from '../model/run-list';
import type { RunStatusCounts, StatusSample } from '../workflow-runs.queries';

/** One live count in a page header's mono line, e.g. "3 running". */
export function RunCount({
  tone,
  sample,
  label,
}: Readonly<{ tone: StatusTone; sample: StatusSample; label: string }>) {
  return (
    <Status tone={tone} className="font-mono text-xs font-normal">
      <span className="text-subtle-foreground">
        <b className="font-medium text-foreground">{countLabel(sample)}</b>{' '}
        {label}
      </span>
    </Status>
  );
}

/** Running, waiting and queued counts, for the Home and Runs headers. */
export function LiveRunCounts({
  counts,
}: Readonly<{ counts: RunStatusCounts }>) {
  return (
    <>
      <RunCount tone="live" sample={counts.running} label="running" />
      <RunCount tone="waiting" sample={counts.waiting} label="waiting" />
      <RunCount tone="queued" sample={counts.queued} label="queued" />
    </>
  );
}
