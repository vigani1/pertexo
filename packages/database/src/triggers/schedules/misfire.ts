export type ScheduleOccurrenceDisposition = 'accepted' | 'skipped';

/**
 * ADR 014 as amended by ADR 049. `catch_up_once` admits the greatest due
 * occurrence. `skip` admits it too when the database-time observation is at
 * most the on-time window after its scheduled instant, and otherwise records
 * it skipped. Neither policy enumerates earlier missed occurrences.
 */
export function scheduleOccurrenceDisposition(
  input: Readonly<{
    misfirePolicy: 'catch_up_once' | 'skip';
    scheduledAt: Date;
    observedAt: Date;
    onTimeWindowSeconds: number;
  }>,
): ScheduleOccurrenceDisposition {
  if (input.misfirePolicy === 'catch_up_once') return 'accepted';
  const lateMillis = input.observedAt.getTime() - input.scheduledAt.getTime();
  return lateMillis <= input.onTimeWindowSeconds * 1_000
    ? 'accepted'
    : 'skipped';
}
