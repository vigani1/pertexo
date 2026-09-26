import { StatusGlyph } from '@/components/ui/status';
import { statusToneText } from '@/components/ui/status-tone';
import { cn } from '@/lib/utils';
import type { ThreadRow } from '../../model/thread-view';
import { stepTag } from '../../model/step-copy';
import { RunLoadingWave } from './run-loading-wave';

/**
 * On phones the Thread tab is the run's steps as a list: each step's name,
 * a second line with its status and timing ("Waiting · resumes in 12m"),
 * and its glyph. Tapping one opens it.
 */
export function RunStepList({
  rows,
  active,
  nowMs,
  selectedKey,
  onSelectStep,
}: Readonly<{
  rows: readonly ThreadRow[];
  active: boolean;
  nowMs: number;
  selectedKey: string | undefined;
  onSelectStep: (key: string) => void;
}>) {
  const waiting = active && rows.every((row) => row.status === 'not_started');
  if (rows.length === 0)
    return (
      <p className="py-6 text-sm text-muted-foreground">
        {active
          ? 'Waiting for the first step to start…'
          : 'No steps ran in this run.'}
      </p>
    );
  return (
    <section aria-labelledby="run-steps-title" className="relative">
      {waiting ? <RunLoadingWave /> : null}
      <h2
        id="run-steps-title"
        className="font-sans text-xs font-semibold text-subtle-foreground"
      >
        Steps
      </h2>
      <ol className="relative mt-2 flex flex-col">
        {rows.map((row) => (
          <li key={row.key}>
            <button
              type="button"
              aria-pressed={row.key === selectedKey}
              aria-label={`${row.label}: ${row.statusLabel}${row.attempts > 1 ? `, ${String(row.attempts)} attempts` : ''}`}
              className="flex min-h-12 w-full items-center justify-between gap-3 border-t border-white/6 px-1 py-2 text-left outline-none focus-ring aria-pressed:bg-action/[0.06]"
              onClick={() => {
                onSelectStep(row.key);
              }}
            >
              <span className="min-w-0">
                <span className="block truncate text-[0.95rem]">
                  {row.label}
                </span>
                <span className="block truncate font-mono text-[0.72rem] text-subtle-foreground">
                  {stepLine(row, nowMs)}
                </span>
              </span>
              <span
                className={cn(
                  'flex shrink-0 items-center gap-1.5 font-mono text-xs',
                  statusToneText[row.tone],
                )}
              >
                <StatusGlyph tone={row.tone} />
                {row.attempts > 1 ? `×${String(row.attempts)}` : null}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** "Succeeded · 0.04s", "Waiting · resumes in 12m": the thread's tag in words. */
function stepLine(row: ThreadRow, nowMs: number): string {
  const tag = stepTag(row, nowMs);
  if (tag === '') return row.statusLabel;
  // A tag that already starts with the status ("skipped · not taken")
  // stands alone, so the line never says it twice.
  if (tag.toLocaleLowerCase().startsWith(row.statusLabel.toLocaleLowerCase()))
    return `${tag.charAt(0).toLocaleUpperCase()}${tag.slice(1)}`;
  return `${row.statusLabel} · ${tag}`;
}
