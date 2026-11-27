import { cn } from '@/lib/class-names';
import { formatCount } from '@/lib/format/count';
import { formatDateTime } from '@/lib/format/time';
import { FAILURE_STRIP_DAYS, type FailureStrip } from '../../model/run-strip';

/**
 * The last week as one quiet thread ending in a knot at now, with a short red
 * tick for each failure. A week without runs is a faint dashed line.
 */
export function RunStrip({ strip }: Readonly<{ strip: FailureStrip }>) {
  const label = `Last ${String(FAILURE_STRIP_DAYS)} days: ${stripSummary(strip)}`;
  return (
    <span role="img" aria-label={label} className="relative block h-4 w-full">
      <span
        aria-hidden="true"
        className={cn(
          'absolute top-1/2 right-0 -translate-y-1/2',
          strip.start === undefined
            ? 'left-0 border-t border-dashed border-border'
            : 'h-px bg-border-strong',
        )}
        style={
          strip.start === undefined
            ? undefined
            : { left: `${String(strip.start)}%` }
        }
      />
      {strip.start === undefined ? null : (
        <span
          aria-hidden="true"
          className="absolute top-1/2 right-0 size-1 -translate-y-1/2 rounded-full bg-subtle-foreground"
        />
      )}
      {strip.ticks.map((tick, index) => (
        <span
          key={`${tick.at}:${String(index)}`}
          aria-hidden="true"
          title={`Failed ${formatDateTime(tick.at)}`}
          className="absolute top-1/2 h-2.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-destructive"
          style={{ left: `${String(tick.position)}%` }}
        />
      ))}
    </span>
  );
}

function stripSummary(strip: FailureStrip): string {
  if (strip.start === undefined) return 'no runs';
  if (strip.ticks.length === 0) return 'no failures';
  return formatCount(strip.ticks.length, 'failed run');
}
