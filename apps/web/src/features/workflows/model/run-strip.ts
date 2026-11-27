import {
  LIST_SUMMARY_BOUNDS,
  type WorkflowRunReadSummary,
} from '@pertexo/contracts';

type RecentRun = Pick<WorkflowRunReadSummary, 'status' | 'createdAt'>;

/** The strip on each workflow row covers the last week. */
export const FAILURE_STRIP_DAYS = 7;
const WINDOW_MS = FAILURE_STRIP_DAYS * 86_400_000;

export type FailureTick = Readonly<{ at: string; position: number }>;

/**
 * A workflow's failures over the last week, as positions from 0 (a week ago)
 * to 100 (now). The list summary carries only the latest runs; when it is
 * full and all of them fall inside the week, earlier runs are unknown, so
 * the thread starts at the oldest one it has. A week without runs has no
 * thread at all.
 */
export type FailureStrip = Readonly<{
  ticks: readonly FailureTick[];
  start: number | undefined;
}>;

export function failureStrip(
  runs: readonly RecentRun[],
  nowMs: number,
): FailureStrip {
  const position = (run: RecentRun) =>
    100 * (1 - (nowMs - Date.parse(run.createdAt)) / WINDOW_MS);
  const inWeek = runs.filter((run) => {
    const age = nowMs - Date.parse(run.createdAt);
    return age >= 0 && age < WINDOW_MS;
  });
  if (inWeek.length === 0) return { ticks: [], start: undefined };
  const capped =
    inWeek.length === runs.length &&
    runs.length >= LIST_SUMMARY_BOUNDS.recentRunsItems;
  return {
    ticks: inWeek
      .filter((run) => run.status === 'failed' || run.status === 'timed_out')
      .map((run) => ({ at: run.createdAt, position: position(run) })),
    start: capped ? Math.min(...inWeek.map(position)) : 0,
  };
}
