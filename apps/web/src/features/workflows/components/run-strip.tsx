import type { StatusTone } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import {
  RUN_STRIP_LENGTH,
  summarizeRunTicks,
  type RunTick,
} from '../model/run-strip';

const TICK_CLASS: Readonly<Record<StatusTone, string>> = {
  live: 'bg-primary shadow-[0_0_6px_var(--primary)] motion-safe:animate-blink',
  queued: 'bg-secondary',
  waiting: 'bg-secondary',
  success: 'bg-success/75',
  failure: 'bg-destructive',
  timeout: 'bg-destructive',
  attention: 'bg-warning',
  canceled: 'bg-subtle-foreground/60',
  skipped: 'bg-subtle-foreground/40',
  neutral: 'bg-muted-foreground/50',
};

/**
 * One tick per run, oldest to newest, padded on the left with empty ticks:
 * an empty tick means "not among the recent runs", never "didn't run".
 */
export function RunStrip({ ticks }: Readonly<{ ticks: readonly RunTick[] }>) {
  if (ticks.length === 0)
    return (
      <span className="font-mono text-[0.7rem] text-subtle-foreground">
        None recently
      </span>
    );
  const padding = Math.max(0, RUN_STRIP_LENGTH - ticks.length);
  return (
    <span
      role="img"
      aria-label={`Recent runs: ${summarizeRunTicks(ticks)}`}
      className="flex h-4 items-end gap-[3px]"
    >
      {Array.from({ length: padding }, (_, index) => (
        <span
          key={`empty-${String(index)}`}
          className="h-3.5 w-1 rounded-[2px] bg-white/7"
        />
      ))}
      {ticks.map((tick, index) => (
        <span
          key={String(index)}
          className={cn('h-3.5 w-1 rounded-[2px]', TICK_CLASS[tick.tone])}
        />
      ))}
    </span>
  );
}

export function RunStripPlaceholder() {
  return (
    <span aria-hidden="true" className="flex h-4 items-end gap-[3px]">
      {Array.from({ length: RUN_STRIP_LENGTH }, (_, index) => (
        <span
          key={String(index)}
          className="h-3.5 w-1 rounded-[2px] bg-white/5 motion-safe:animate-blink"
        />
      ))}
    </span>
  );
}
