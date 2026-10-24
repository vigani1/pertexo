import type {
  WorkflowGraphContract,
  WorkflowRunSummary,
} from '@pertexo/contracts';
import { formatDurationMs, formatShortTime } from '@/lib/format/time';
import { runDurationMs } from '../list/runs';
import { isActiveRunStatus } from './run-status';
import type { RunTimelineRow, RunTimelineStepStatus } from '../timeline/runs';

type StepFacts = Pick<
  RunTimelineRow,
  'label' | 'status' | 'attempts' | 'story' | 'resumeAt' | 'failureHandling'
>;

function lastWith(
  rows: readonly StepFacts[],
  status: RunTimelineStepStatus,
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
    // A headline, not a log line: to the minute, like the rest of the page.
    return `Waiting until ${formatShortTime(waiting.resumeAt)}`;
  if (waiting !== undefined) return `${waiting.label} is waiting`;
  return run.status === 'waiting' ? 'Waiting' : 'Running';
}

function failedSentence(
  rows: readonly StepFacts[],
  durationMs: number | undefined,
): string {
  const failed = lastWith(
    rows.filter((row) => row.failureHandling?.disposition !== 'handled'),
    'failed',
  );
  if (failed === undefined) return withDuration('Failed', durationMs);
  return failed.attempts > 1
    ? `Failed at ${failed.label} after ${String(failed.attempts)} attempts`
    : `Failed at ${failed.label}`;
}

const STOP_RUN = 'core.terminate';

/**
 * The word the workflow ended on, when a Stop run step that finished the run
 * names a fixed outcome, such as "rejected". Computed outcomes stay unnamed.
 */
export function runEnding(
  rows: readonly Pick<RunTimelineRow, 'nodeId' | 'definitionKey' | 'status'>[],
  graph: Pick<WorkflowGraphContract, 'nodes'> | undefined,
): string | undefined {
  const stop = rows.find(
    (row) => row.definitionKey === STOP_RUN && row.status === 'succeeded',
  );
  const mapping = graph?.nodes.find((node) => node.id === stop?.nodeId)
    ?.inputMappings.outcome;
  return mapping?.kind === 'literal' &&
    typeof mapping.value === 'string' &&
    mapping.value.trim() !== ''
    ? mapping.value.trim()
    : undefined;
}

/**
 * The run page's headline: one sentence that says where the run is, instead
 * of a status badge. "Retrying Send receipt", "Succeeded in 4.2 s".
 */
export function describeRunSentence(
  run: Pick<
    WorkflowRunSummary,
    | 'status'
    | 'startedAt'
    | 'completedAt'
    | 'updatedAt'
    | 'cancelRequestedAt'
    | 'handledFailureCount'
  >,
  rows: readonly StepFacts[],
  nowMs: number,
  /** The workflow's own word for how it ended, from `runEnding`. */
  ending?: string,
): string {
  const active = isActiveRunStatus(run.status);
  if (active && run.cancelRequestedAt !== null) return 'Stopping…';
  if (active) return activeSentence(run, rows);
  const durationMs = runDurationMs(run, nowMs);
  switch (run.status) {
    case 'succeeded':
      if ((run.handledFailureCount ?? 0) > 0)
        return `Finished — ${String(run.handledFailureCount)} ${run.handledFailureCount === 1 ? 'failure' : 'failures'} handled`;
      {
        const succeeded =
          ending === undefined ? 'Succeeded' : `Succeeded as “${ending}”`;
        return durationMs === undefined
          ? succeeded
          : `${succeeded} in ${formatDurationMs(durationMs)}`;
      }
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
    case 'outcome_unknown':
    case 'queued':
    case 'running':
    case 'waiting':
    default: {
      const step = lastWith(rows, 'outcome_unknown');
      return step === undefined
        ? 'Outcome unknown'
        : `Outcome unknown at ${step.label}`;
    }
  }
}
