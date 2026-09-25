import { StatusGlyph } from '@/components/ui/status';
import { statusToneText } from '@/components/ui/status-tone';
import { cn } from '@/lib/utils';
import type { ThreadRow } from '../../model/thread-view';
import { RunLoadingWave } from './run-loading-wave';

/**
 * On phones the Thread tab is the run's steps as a list: each step's name,
 * its status glyph and how many attempts it took. Tapping one opens it.
 */
export function RunStepList({
  rows,
  active,
  selectedKey,
  onSelectStep,
}: Readonly<{
  rows: readonly ThreadRow[];
  active: boolean;
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
              className="flex min-h-12 w-full items-center justify-between gap-3 border-t border-white/6 px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 aria-pressed:bg-primary/[0.05]"
              onClick={() => {
                onSelectStep(row.key);
              }}
            >
              <span className="min-w-0 truncate text-[0.95rem]">
                {row.label}
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
