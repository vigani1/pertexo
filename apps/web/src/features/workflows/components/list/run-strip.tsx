import { statusToneText } from '@/components/patterns/status/status-tone';
import { describeRunStatus } from '@/features/workflow-runs/public';
import { cn } from '@/lib/class-names';
import { formatDateTime } from '@/lib/format/time';
import { describeFailureStrip, type FailureStrip } from '../../model/run-strip';

/**
 * The last week as a thread ending in a knot at now, with a status-coloured
 * tick for each unsuccessful run. A week without runs is a faint dashed line.
 */
export function RunStrip({ strip }: Readonly<{ strip: FailureStrip }>) {
  const label = describeFailureStrip(strip);
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
      {strip.ticks.map((tick, index) => {
        const look = describeRunStatus(tick);
        return (
          <span
            key={`${tick.at}:${String(index)}`}
            aria-hidden="true"
            title={`${look.label} ${formatDateTime(tick.at)}`}
            className={cn(
              'absolute top-1/2 h-2.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current',
              statusToneText[look.tone],
            )}
            style={{ left: `${String(tick.position)}%` }}
          />
        );
      })}
    </span>
  );
}
