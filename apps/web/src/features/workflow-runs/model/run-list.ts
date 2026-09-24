import type {
  WorkflowRunReadSummary,
  WorkflowRunSummary,
} from '@pertexo/contracts/schemas/workflow-runs';
import { formatDayHeading } from '@/lib/format-time';
import { localDateValue } from './run-search';
import { isActiveRunStatus, type RunTriggerType } from './run-status';

export type RunDayGroup = Readonly<{
  key: string;
  heading: string;
  runs: readonly WorkflowRunReadSummary[];
}>;

/** Groups an ordered list under local calendar days, newest first. */
export function groupRunsByDay(
  runs: readonly WorkflowRunReadSummary[],
  nowMs: number,
): readonly RunDayGroup[] {
  const groups: {
    key: string;
    heading: string;
    runs: WorkflowRunReadSummary[];
  }[] = [];
  for (const run of runs) {
    const key = localDateValue(Date.parse(run.createdAt));
    const current = groups.at(-1);
    if (current?.key === key) current.runs.push(run);
    else
      groups.push({
        key,
        heading: formatDayHeading(run.createdAt, nowMs),
        runs: [run],
      });
  }
  return groups;
}

/**
 * How long the run has taken: start to finish, or start to now while it is
 * still active. Queued runs haven't started, so they have no duration.
 */
export function runDurationMs(
  run: Pick<
    WorkflowRunSummary,
    'status' | 'startedAt' | 'completedAt' | 'updatedAt'
  >,
  nowMs: number,
): number | undefined {
  if (run.startedAt === null) return undefined;
  const start = Date.parse(run.startedAt);
  if (isActiveRunStatus(run.status)) return Math.max(0, nowMs - start);
  const end = Date.parse(run.completedAt ?? run.updatedAt);
  return Math.max(0, end - start);
}

/**
 * A log-scaled share (0–1) of the longest visible duration, so a 2 s run
 * and a 20 min run are both readable in the same list.
 */
export function threadBarScale(
  durations: readonly (number | undefined)[],
): (durationMs: number | undefined) => number {
  let longest = 0;
  for (const duration of durations)
    if (duration !== undefined && duration > longest) longest = duration;
  const ceiling = Math.log1p(Math.max(longest, 1_000));
  return (durationMs) =>
    durationMs === undefined
      ? 0
      : Math.min(1, Math.max(0.04, Math.log1p(durationMs) / ceiling));
}

/** `7f3a…0c21`: enough to tell runs apart and to search for. */
export function shortRunId(id: string): string {
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

export function filterRunsByTrigger(
  runs: readonly WorkflowRunReadSummary[],
  trigger: RunTriggerType | undefined,
): readonly WorkflowRunReadSummary[] {
  return trigger === undefined
    ? runs
    : runs.filter((run) => run.triggerType === trigger);
}

export function workflowLabel(
  run: Pick<WorkflowRunReadSummary, 'workflowName'>,
): string {
  return run.workflowName ?? 'Workflow name unavailable';
}

/** "100+" once a status has more runs than one bounded page holds. */
export function countLabel(
  sample: Readonly<{ count: number; more: boolean }>,
): string {
  return sample.more ? `${String(sample.count)}+` : String(sample.count);
}
