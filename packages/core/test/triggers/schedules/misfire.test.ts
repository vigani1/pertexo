import { describe, expect, it } from 'vitest';
import { scheduleOccurrenceDisposition } from '../../../src/triggers/schedules/misfire.js';
import {
  parseScheduleRecurrence,
  resolveScheduleObservation,
} from '../../../src/triggers/schedules/recurrence.js';

describe.each([
  {
    name: 'hourly interval',
    recurrence: { kind: 'interval', intervalMinutes: 60 },
    anchor: '2026-03-08T06:00:00.000Z',
    due: '2026-03-08T07:00:00.000Z',
  },
  {
    name: 'New York spring-gap occurrence',
    recurrence: {
      kind: 'cron',
      expression: '30 2 * * *',
      timezone: 'America/New_York',
    },
    anchor: '2026-03-07T07:30:00.000Z',
    due: '2026-03-08T07:00:00.000Z',
  },
])('$name misfire cutoff', ({ recurrence, anchor, due }) => {
  it.each([
    { lateMillis: 300_000, expected: 'accepted' },
    { lateMillis: 300_001, expected: 'skipped' },
  ] as const)(
    '$lateMillis milliseconds late is $expected',
    ({ lateMillis, expected }) => {
      const observedAt = new Date(Date.parse(due) + lateMillis);
      const resolved = resolveScheduleObservation(
        parseScheduleRecurrence(recurrence),
        new Date(anchor),
        observedAt,
      );
      expect(resolved.greatestDueAt).toEqual(new Date(due));
      if (resolved.greatestDueAt === null)
        throw new Error('Occurrence was not due');
      expect(
        scheduleOccurrenceDisposition({
          misfirePolicy: 'skip',
          scheduledAt: resolved.greatestDueAt,
          observedAt,
          onTimeWindowSeconds: 300,
        }),
      ).toBe(expected);
    },
  );
});
