import { formatClock, formatDurationMs } from '@/lib/format/time';
import type { StepStoryEntry } from '../timeline/step-replay';
import type { RunTimelineRow } from '../timeline/run-timeline-model';

function spanMs(entry: Pick<StepStoryEntry, 'startedAt' | 'endedAt'>) {
  return entry.endedAt === undefined
    ? undefined
    : Date.parse(entry.endedAt) - Date.parse(entry.startedAt);
}

function countdown(targetIso: string, nowMs: number): string | undefined {
  const remaining = Date.parse(targetIso) - nowMs;
  return remaining > 0 ? formatDurationMs(remaining) : undefined;
}

function lastAttempt(row: RunTimelineRow): StepStoryEntry | undefined {
  for (let index = row.story.length - 1; index >= 0; index -= 1) {
    const entry = row.story[index];
    if (entry?.kind === 'attempt') return entry;
  }
  return undefined;
}

/** The short note beside a step's thread: "attempt 2", "retry in 24 s". */
export function stepTag(row: RunTimelineRow, nowMs: number): string {
  const retrying = row.story.at(-1)?.kind === 'retry';
  switch (row.status) {
    case 'running': {
      if (row.attempts > 1) return `attempt ${String(row.attempts)}`;
      const started = lastAttempt(row)?.startedAt ?? row.startedAt;
      return started === undefined
        ? 'running'
        : formatDurationMs(nowMs - Date.parse(started));
    }
    case 'waiting': {
      const left =
        row.resumeAt === undefined ? undefined : countdown(row.resumeAt, nowMs);
      if (left === undefined) return retrying ? 'retrying soon' : 'waiting';
      return retrying ? `retry in ${left}` : `resumes in ${left}`;
    }
    case 'succeeded': {
      const attempt = lastAttempt(row);
      const took = attempt === undefined ? undefined : spanMs(attempt);
      return took === undefined ? 'done' : formatDurationMs(took);
    }
    case 'failed': {
      // The status beside it already says failed: how long, or how often.
      if (row.attempts > 1) return `after ${String(row.attempts)} attempts`;
      const attempt = lastAttempt(row);
      const took = attempt === undefined ? undefined : spanMs(attempt);
      return took === undefined ? '' : formatDurationMs(took);
    }
    case 'skipped':
      return 'skipped · not taken';
    case 'pending':
    case 'ready':
      return 'waiting to start';
    default:
      return row.statusLabel.toLocaleLowerCase();
  }
}

const outcomeWords: Readonly<Record<StepStoryEntry['outcome'], string>> = {
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  timed_out: 'timed out',
  canceled: 'was canceled',
  outcome_unknown: 'lost contact',
  scheduled: 'scheduled',
  waiting: 'is waiting',
  skipped: 'skipped',
};

/** "Attempt 1 failed", "Retry scheduled", "Waiting". */
export function storyEntryTitle(entry: StepStoryEntry): string {
  switch (entry.kind) {
    case 'retry':
      return 'Retry scheduled';
    case 'wait':
      return entry.endedAt === undefined ? 'Waiting' : 'Waited';
    case 'skipped':
      return 'Skipped: the branch wasn’t taken';
    case 'attempt':
      return `${
        entry.attemptNumber === undefined
          ? 'This step'
          : `Attempt ${String(entry.attemptNumber)}`
      } ${outcomeWords[entry.outcome]}`;
  }
}

/** The mono facts under a story entry: times, durations, countdowns. */
export function storyEntryMeta(entry: StepStoryEntry, nowMs: number): string {
  const took = spanMs(entry);
  if (entry.kind === 'retry' || entry.kind === 'wait') {
    if (took !== undefined) return `waited ${formatDurationMs(took)}`;
    const left =
      entry.dueAt === undefined ? undefined : countdown(entry.dueAt, nowMs);
    if (left === undefined) return `since ${formatClock(entry.startedAt)}`;
    return `${entry.kind === 'retry' ? 'retries' : 'resumes'} in ${left} · at ${formatClock(entry.dueAt)}`;
  }
  if (entry.outcome === 'running')
    return `since ${formatClock(entry.startedAt)} · ${formatDurationMs(
      nowMs - Date.parse(entry.startedAt),
    )}`;
  return took === undefined
    ? formatClock(entry.startedAt)
    : `${formatClock(entry.startedAt)} · ${formatDurationMs(took)}`;
}

// Why a step ended the way it did, when the engine says: a Merge that
// couldn't start, or a failure it didn't try again.
const joinReasons: Readonly<Record<string, string>> = {
  branch_failed: 'It didn’t start: a branch it waits for failed.',
  branch_canceled: 'It didn’t start: a branch it waits for was canceled.',
  insufficient_arrivals: 'It didn’t start: not enough branches reached it.',
};

/**
 * One sentence on why a finished entry ended the way it did, or nothing
 * when the story already says it. A failure names why there was no retry:
 * the last attempt, a kind of failure this step doesn't retry, or a call
 * that may already have reached the service.
 */
export function storyEntryReason(entry: StepStoryEntry): string | undefined {
  const code = entry.reasonCode;
  if (code === undefined) return undefined;
  const join = joinReasons[code];
  if (join !== undefined) return join;
  if (code === 'unsafe_possible_dispatch')
    return 'Not retried: it may already have reached the service, and trying again could do it twice.';
  if (code === 'canceled' || entry.outcome !== 'failed') return undefined;
  return entry.attemptNumber !== undefined && entry.attemptNumber > 1
    ? `Pertexo stopped retrying after attempt ${String(entry.attemptNumber)}.`
    : 'Not retried: this step doesn’t retry this kind of failure.';
}
