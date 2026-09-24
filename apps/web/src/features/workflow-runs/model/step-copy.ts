import { formatClock, formatDurationMs } from '@/lib/format-time';
import type { StepStoryEntry } from './step-replay';
import type { ThreadRow } from './thread-view';

function spanMs(entry: Pick<StepStoryEntry, 'startedAt' | 'endedAt'>) {
  return entry.endedAt === undefined
    ? undefined
    : Date.parse(entry.endedAt) - Date.parse(entry.startedAt);
}

function countdown(targetIso: string, nowMs: number): string | undefined {
  const remaining = Date.parse(targetIso) - nowMs;
  return remaining > 0 ? formatDurationMs(remaining) : undefined;
}

function lastAttempt(row: ThreadRow): StepStoryEntry | undefined {
  for (let index = row.story.length - 1; index >= 0; index -= 1) {
    const entry = row.story[index];
    if (entry?.kind === 'attempt') return entry;
  }
  return undefined;
}

/** The short note beside a step's thread: "attempt 2", "retry in 24 s". */
export function stepTag(row: ThreadRow, nowMs: number): string {
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
    case 'failed':
      return row.attempts > 1
        ? `failed after ${String(row.attempts)} attempts`
        : 'failed';
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
