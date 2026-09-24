import type { WorkflowRunSummary } from '@pertexo/contracts/schemas/workflow-runs';
import { formatClock, formatDurationMs } from '@/lib/format-time';
import { runDurationMs } from './run-list';
import { isActiveRunStatus } from './run-status';
import type { ThreadRow, ThreadStepStatus } from './thread-view';

type StepFacts = Pick<
  ThreadRow,
  'label' | 'status' | 'attempts' | 'story' | 'resumeAt'
>;

function lastWith(
  rows: readonly StepFacts[],
  status: ThreadStepStatus,
): StepFacts | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.status === status) return row;
  }
  return undefined;
}

function isRetrying(row: StepFacts): boolean {
  return row.status === 'waiting' && row.story.at(-1)?.kind === 'retry';
}

function withDuration(prefix: string, durationMs: number | undefined): string {
  return durationMs === undefined
    ? prefix
    : `${prefix} after ${formatDurationMs(durationMs)}`;
}

function activeSentence(
  run: Pick<WorkflowRunSummary, 'status'>,
  rows: readonly StepFacts[],
): string {
  if (run.status === 'queued') return 'Waiting to start';
  const retrying = rows.find(isRetrying);
  if (retrying !== undefined) return `Retrying ${retrying.label}`;
  const running = rows.filter((row) => row.status === 'running');
  const [only] = running;
  if (running.length === 1 && only !== undefined)
    return only.attempts > 1
      ? `Retrying ${only.label}`
      : `Running ${only.label}`;
  if (running.length > 1) return `Running ${String(running.length)} steps`;
  const waiting = rows.find((row) => row.status === 'waiting');
  if (waiting?.resumeAt !== undefined)
    return `Waiting until ${formatClock(waiting.resumeAt)}`;
  if (waiting !== undefined) return `${waiting.label} is waiting`;
  return run.status === 'waiting' ? 'Waiting' : 'Running';
}

function failedSentence(
  rows: readonly StepFacts[],
  durationMs: number | undefined,
): string {
  const failed = lastWith(rows, 'failed');
  if (failed === undefined) return withDuration('Failed', durationMs);
  return failed.attempts > 1
    ? `Failed at ${failed.label} after ${String(failed.attempts)} attempts`
    : `Failed at ${failed.label}`;
}

/**
 * The run page's headline: one sentence that says where the run is, instead
 * of a status badge. "Retrying Send receipt", "Succeeded in 4.2 s".
 */
export function describeRunSentence(
  run: Pick<
    WorkflowRunSummary,
    'status' | 'startedAt' | 'completedAt' | 'updatedAt' | 'cancelRequestedAt'
  >,
  rows: readonly StepFacts[],
  nowMs: number,
): string {
  const active = isActiveRunStatus(run.status);
  if (active && run.cancelRequestedAt !== null) return 'Stopping…';
  if (active) return activeSentence(run, rows);
  const durationMs = runDurationMs(run, nowMs);
  switch (run.status) {
    case 'succeeded':
      return durationMs === undefined
        ? 'Succeeded'
        : `Succeeded in ${formatDurationMs(durationMs)}`;
    case 'failed':
      return failedSentence(rows, durationMs);
    case 'timed_out': {
      const step = lastWith(rows, 'timed_out');
      return step === undefined
        ? withDuration('Timed out', durationMs)
        : `Timed out at ${step.label}`;
    }
    case 'canceled':
      return withDuration('Canceled', durationMs);
    default: {
      const step = lastWith(rows, 'outcome_unknown');
      return step === undefined
        ? 'Outcome unknown'
        : `Outcome unknown at ${step.label}`;
    }
  }
}
