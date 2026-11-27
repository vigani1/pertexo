import {
  StatusMark,
  type StatusTone,
} from '@/components/patterns/status/status-mark';
import type { RunStatistics } from '../data/statistics.queries';
import { FORMAT_LOCALE } from '@/lib/format/locale';

/**
 * One exact count in a page header's mono line, e.g. "3 running". Colour
 * means attention, so a zero is plain ink with no mark.
 */
export function RunCount({
  tone,
  count,
  label,
}: Readonly<{ tone: StatusTone; count: number; label: string }>) {
  const words = (
    <span className="text-subtle-foreground">
      <b className="font-medium text-foreground">
        {count.toLocaleString(FORMAT_LOCALE)}
      </b>{' '}
      {label}
    </span>
  );
  if (count === 0)
    return <span className="font-mono text-meta leading-none">{words}</span>;
  return (
    <StatusMark tone={tone} className="font-mono">
      {words}
    </StatusMark>
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
