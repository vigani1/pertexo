import type { WorkflowRunReadSummary } from '@pertexo/contracts/schemas/workflow-runs';
import type { StatusTone } from '@/components/ui/status';

export const RUN_STRIP_LENGTH = 20;

type RecentRun = Pick<WorkflowRunReadSummary, 'status' | 'createdAt'>;

export type RunTick = Readonly<{ tone: StatusTone; word: string }>;

const TICKS: Readonly<Record<RecentRun['status'], RunTick>> = {
  queued: { tone: 'waiting', word: 'waiting' },
  waiting: { tone: 'waiting', word: 'waiting' },
  running: { tone: 'live', word: 'running' },
  succeeded: { tone: 'success', word: 'succeeded' },
  failed: { tone: 'failure', word: 'failed' },
  timed_out: { tone: 'failure', word: 'timed out' },
  canceled: { tone: 'canceled', word: 'canceled' },
  outcome_unknown: { tone: 'attention', word: 'unknown outcome' },
};

/**
 * A workflow's latest runs as ticks, oldest to newest, at most the last 20.
 * Runs arrive newest first; the order is settled by their start here.
 */
export function runTicks(runs: readonly RecentRun[]): readonly RunTick[] {
  return runs
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, RUN_STRIP_LENGTH)
    .reverse()
    .map((run) => TICKS[run.status]);
}

/** "3 succeeded, 1 failed" — the accessible reading of a strip. */
export function summarizeRunTicks(ticks: readonly RunTick[]): string {
  const counts = new Map<string, number>();
  for (const tick of ticks)
    counts.set(tick.word, (counts.get(tick.word) ?? 0) + 1);
  return [...counts.entries()]
    .map(([word, count]) => `${String(count)} ${word}`)
    .join(', ');
}
