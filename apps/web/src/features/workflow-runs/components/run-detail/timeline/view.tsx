import { StatusGlyph } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import { stepTag } from '../../../model/step-inspection/copy';
import type { RunTimelineModel } from '../../../model/timeline/runs';
import { toneBorderClass } from '../../../model/presentation/tone-styles';
import { RunLoadingWave } from './loading-wave';
import { RunTimelineTrack } from './track';

/**
 * The signature run view: one row per step invocation on a shared time
 * axis. Each row is a button that opens the step in the lens.
 */
export function RunTimeline({
  view,
  nowMs,
  active,
  selectedKey,
  onSelectStep,
}: Readonly<{
  view: RunTimelineModel;
  nowMs: number;
  active: boolean;
  selectedKey: string | undefined;
  onSelectStep: (key: string) => void;
}>) {
  const span = view.endMs - view.startMs;
  // Queued, or started without a step yet: the loading wave runs under the
  // plan of steps until the first one starts.
  const waiting =
    active && view.rows.every((row) => row.status === 'not_started');
  if (view.rows.length === 0)
    return (
      <div className="relative grid h-64 place-items-center overflow-hidden rounded-xl border border-surface-ink/6">
        {active ? <RunLoadingWave /> : null}
        <p className="relative text-sm text-muted-foreground">
          {active
            ? 'Waiting for the first step to start…'
            : 'No steps ran in this run.'}
        </p>
      </div>
    );
  return (
    // Columns follow the thread's own width, not the window's: beside the
    // step lens it is narrower than the screen.
    <div
      className={cn(
        '@container relative rounded-xl border border-surface-ink/6 px-2 pt-3 pb-2 @xl:px-4',
        active && 'live-edge',
      )}
    >
      {waiting ? <RunLoadingWave /> : null}
      <div
        aria-hidden="true"
        className="grid grid-cols-[9rem_minmax(0,1fr)] px-2.5 font-mono text-[0.66rem] text-subtle-foreground @xl:grid-cols-[13rem_minmax(0,1fr)]"
      >
        <span />
        <div className="relative mr-3 h-5 @xl:mr-6">
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
      <ol aria-label="Steps in this run" className="relative flex flex-col">
        {view.rows.map((row) => {
          const selected = row.key === selectedKey;
          return (
            // The divider is an inset line, not the row's border, so a
            // selected or hovered row hides the lines on both its edges.
            <li
              key={row.key}
              className="relative before:pointer-events-none before:absolute before:inset-x-2.5 before:top-0 before:h-px before:bg-surface-ink/5 first:before:hidden has-[button:hover]:before:opacity-0 has-[[aria-pressed=true]]:before:opacity-0 [:has(button:hover)+&]:before:opacity-0 [:has([aria-pressed=true])+&]:before:opacity-0"
            >
              <button
                type="button"
                aria-pressed={selected}
                aria-label={`${row.label}: ${row.statusLabel}, ${stepTag(row, nowMs)}`}
                className={cn(
                  'grid h-13 w-full grid-cols-[9rem_minmax(0,1fr)] items-center rounded-lg px-2.5 text-left outline-none transition-colors duration-150 hover:bg-surface-ink/[0.035] focus-ring motion-reduce:transition-none @xl:grid-cols-[13rem_minmax(0,1fr)]',
                  selected &&
                    'bg-action/[0.07] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--action)_24%,transparent)] hover:bg-action/[0.09]',
                )}
                onClick={() => {
                  onSelectStep(row.key);
                }}
              >
                <span className="flex min-w-0 items-center gap-2.5 pr-3">
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
                <span className="relative mr-3 h-full @xl:mr-6">
                  <RunTimelineTrack
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
