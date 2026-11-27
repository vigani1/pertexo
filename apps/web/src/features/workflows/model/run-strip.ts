import {
  LIST_SUMMARY_BOUNDS,
  type WorkflowRunReadSummary,
} from '@pertexo/contracts';
import {
  UNSUCCESSFUL_RUN_STATUSES,
  type UnsuccessfulRunStatus,
} from '@pertexo/workflow-model';
import { formatCount } from '@/lib/format/count';

type RecentRun = Pick<WorkflowRunReadSummary, 'status' | 'createdAt'>;
type UnsuccessfulRun = RecentRun & Readonly<{ status: UnsuccessfulRunStatus }>;

const unsuccessfulStatuses: ReadonlySet<RecentRun['status']> = new Set(
  UNSUCCESSFUL_RUN_STATUSES,
);

/** The strip on each workflow row covers the last week. */
export const FAILURE_STRIP_DAYS = 7;
const WINDOW_MS = FAILURE_STRIP_DAYS * 86_400_000;

export type FailureTick = Readonly<{
  at: string;
  position: number;
  status: UnsuccessfulRunStatus;
}>;

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
      .filter((run): run is UnsuccessfulRun =>
        unsuccessfulStatuses.has(run.status),
      )
      .map((run) => ({
        at: run.createdAt,
        position: position(run),
        status: run.status,
      })),
    start: capped ? Math.min(...inWeek.map(position)) : 0,
  };
}

export function describeFailureStrip(strip: FailureStrip): string {
  return `Last ${String(FAILURE_STRIP_DAYS)} days: ${stripSummary(strip)}`;
}

function stripSummary(strip: FailureStrip): string {
  if (strip.start === undefined) return 'no runs';
  if (strip.ticks.length === 0) return 'no failures';
  const counts = { failed: 0, timed_out: 0, outcome_unknown: 0 };
  for (const tick of strip.ticks) counts[tick.status] += 1;
  return [
    counts.failed > 0 ? formatCount(counts.failed, 'failed run') : null,
    counts.timed_out > 0
      ? `${formatCount(counts.timed_out, 'run')} timed out`
      : null,
    counts.outcome_unknown > 0
      ? formatCount(counts.outcome_unknown, 'unknown outcome')
      : null,
  ]
    .filter((part) => part !== null)
    .join(', ');
}
