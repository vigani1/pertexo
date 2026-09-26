import type {
  ScheduleOccurrenceResponse,
  ScheduleTriggerHealthResponse,
} from '@pertexo/contracts/schemas/schedules';
import type { StatusTone } from '@/components/ui/status';
import { formatDurationMs } from '@/lib/format-time';

type OccurrenceOutcome = Readonly<{
  tone: StatusTone;
  label: string;
  /** Only when there is more to say than the label. */
  detail: string | undefined;
}>;

/** A run time started this long after it was due counts as caught up. */
const LATE_AFTER_MS = 60_000;

/** What one recorded run time of a schedule did, in words (ADR 048). */
export function describeOccurrence(
  occurrence: Pick<
    ScheduleOccurrenceResponse,
    'outcome' | 'scheduledAt' | 'recordedAt'
  >,
): OccurrenceOutcome {
  if (occurrence.outcome === 'skipped')
    return {
      tone: 'skipped',
      label: 'Skipped',
      detail: 'The missed-run setting skipped this run time. No run started.',
    };
  const lateMs =
    Date.parse(occurrence.recordedAt) - Date.parse(occurrence.scheduledAt);
  return {
    tone: 'success',
    // On time is the norm, so only a late start gets a second line.
    label: 'Started a run',
    detail:
      lateMs >= LATE_AFTER_MS
        ? `Caught up ${formatDurationMs(lateMs)} after this run time was due.`
        : undefined,
  };
}

/**
 * Attempts that never become a recorded run time — held back by workspace
 * capacity, or failed before starting — show only in the schedule's health.
 */
export function describeScheduleHold(
  trigger: Pick<ScheduleTriggerHealthResponse, 'lastErrorCode' | 'status'>,
): string | undefined {
  if (trigger.status === 'disabled') return undefined;
  switch (trigger.lastErrorCode) {
    case 'schedule.admission_throttled':
      return 'The latest run time is being held back because too many runs are waiting in this workspace. Pertexo retries it on its own.';
    case 'schedule.scan_failed':
      return 'Pertexo couldn’t start the latest run time. It will try again on its own.';
    default:
      return undefined;
  }
}
