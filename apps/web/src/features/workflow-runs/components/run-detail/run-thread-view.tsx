import { StatusGlyph } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import { stepTag } from '../../model/step-copy';
import type { ThreadView } from '../../model/thread-view';
import { toneBorderClass } from '../../model/tone-styles';
import { RunLoadingWave } from './run-loading-wave';
import { ThreadTrack } from './thread-track';

/**
 * The signature run view: one row per step invocation on a shared time
 * axis. Each row is a button that opens the step in the lens.
 */
export function RunThreadView({
  view,
  nowMs,
  active,
  selectedKey,
  onSelectStep,
}: Readonly<{
  view: ThreadView;
  nowMs: number;
  active: boolean;
  selectedKey: string | undefined;
  onSelectStep: (key: string) => void;
}>) {
  const span = view.endMs - view.startMs;
  if (view.rows.length === 0)
    return (
      <div className="relative grid h-64 place-items-center overflow-hidden rounded-xl border border-white/6">
        {active ? <RunLoadingWave /> : null}
        <p className="relative text-sm text-muted-foreground">
          {active
            ? 'Waiting for the first step to start…'
            : 'No steps ran in this run.'}
        </p>
      </div>
    );
  return (
    <div
      className={cn(
        'rounded-xl border border-white/6 px-2 pt-3 pb-2 sm:px-4',
        active && 'live-edge',
      )}
    >
      <div
        aria-hidden="true"
        className="grid grid-cols-[9rem_minmax(0,1fr)] font-mono text-[0.66rem] text-subtle-foreground sm:grid-cols-[13rem_minmax(0,1fr)]"
      >
        <span />
        <div className="relative mr-3 h-5 sm:mr-36">
          {view.ticks.map((tick) => (
            <span
              key={tick.offsetMs}
              className="absolute -translate-x-1/2 whitespace-nowrap first:translate-x-0"
              style={{ left: `${String((tick.offsetMs / span) * 100)}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>
      </div>
      <ol aria-label="Steps in this run" className="flex flex-col">
        {view.rows.map((row) => {
          const selected = row.key === selectedKey;
          return (
            <li key={row.key}>
              <button
                type="button"
                aria-pressed={selected}
                aria-label={`${row.label}: ${row.statusLabel}, ${stepTag(row, nowMs)}`}
                className={cn(
                  'grid h-12 w-full grid-cols-[9rem_minmax(0,1fr)] items-center rounded-md border-t border-white/5 text-left outline-none hover:bg-white/[0.03] focus-visible:ring-2 focus-visible:ring-ring/60 sm:grid-cols-[13rem_minmax(0,1fr)]',
                  selected && 'bg-primary/[0.05] hover:bg-primary/[0.07]',
                )}
                onClick={() => {
                  onSelectStep(row.key);
                }}
              >
                <span className="flex min-w-0 items-center gap-2.5 pr-3 pl-1">
                  <span
                    className={cn(
                      'grid size-7 shrink-0 place-items-center rounded-md border bg-card',
                      toneBorderClass[row.tone],
                    )}
                  >
                    <StatusGlyph tone={row.tone} className="size-3.5" />
                  </span>
                  <span className="min-w-0 leading-tight">
                    <span className="block truncate text-[0.82rem] font-semibold">
                      {row.label}
                    </span>
                    {row.kindLabel === undefined ? null : (
                      <span className="block truncate text-[0.7rem] text-subtle-foreground">
                        {row.kindLabel}
                      </span>
                    )}
                  </span>
                </span>
                <span className="relative mr-3 h-full sm:mr-36">
                  <ThreadTrack
                    view={view}
                    segments={row.segments}
                    tag={stepTag(row, nowMs)}
                    tone={row.tone}
                    nowMs={nowMs}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
