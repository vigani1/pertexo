import { describe, expect, it } from 'vitest';

import {
  parseScheduleRecurrence,
  resolveScheduleObservation,
  SCHEDULE_CRON_PARSER_VERSION,
} from '../src/triggers/schedule-recurrence.js';

describe('schedule recurrence', () => {
  it('accepts only strict five-field cron in a canonical IANA timezone', () => {
    expect(SCHEDULE_CRON_PARSER_VERSION).toBe('5.10.0');
    expect(
      parseScheduleRecurrence({
        kind: 'cron',
        expression: '30 9 * * 1-5',
        timezone: 'Europe/Paris',
      }),
    ).toMatchObject({ kind: 'cron', timezone: 'Europe/Paris' });

    for (const input of [
      { kind: 'cron', expression: '0 30 9 * * 1-5', timezone: 'Europe/Paris' },
      { kind: 'cron', expression: '30 9 * * * 2027', timezone: 'Europe/Paris' },
      { kind: 'cron', expression: '30 9 * * *', timezone: 'US/Eastern' },
      { kind: 'cron', expression: '30 9 * * *', timezone: 'UTC' },
      { kind: 'cron', expression: '30 9 * * *', timezone: '+02:00' },
    ]) {
      expect(() => parseScheduleRecurrence(input)).toThrow(TypeError);
    }
  });

  it('uses the earlier UTC instant once for a repeated local occurrence', () => {
    const recurrence = parseScheduleRecurrence({
      kind: 'cron',
      expression: '30 1 * * *',
      timezone: 'America/New_York',
    });
    expect(
      resolveScheduleObservation(
        recurrence,
        new Date('2026-10-31T04:00:00.000Z'),
        new Date('2026-11-01T07:00:00.000Z'),
      ),
    ).toEqual({
      greatestDueAt: new Date('2026-11-01T05:30:00.000Z'),
      nextAt: new Date('2026-11-02T06:30:00.000Z'),
    });
  });

  it('moves a nonexistent local occurrence to the first valid instant after the gap', () => {
    const recurrence = parseScheduleRecurrence({
      kind: 'cron',
      expression: '30 2 * * *',
      timezone: 'America/New_York',
    });
    expect(
      resolveScheduleObservation(
        recurrence,
        new Date('2026-03-07T07:30:00.000Z'),
        new Date('2026-03-08T07:00:00.000Z'),
      ),
    ).toEqual({
      greatestDueAt: new Date('2026-03-08T07:00:00.000Z'),
      nextAt: new Date('2026-03-09T06:30:00.000Z'),
    });
  });

  it('anchors intervals immutably and finds multiple missed occurrences without drift', () => {
    const recurrence = parseScheduleRecurrence({
      kind: 'interval',
      intervalMinutes: 15,
    });
    const anchor = new Date('2026-01-01T00:02:03.456Z');
    expect(
      resolveScheduleObservation(
        recurrence,
        anchor,
        new Date('2026-01-01T03:48:00.000Z'),
      ),
    ).toEqual({
      greatestDueAt: new Date('2026-01-01T03:47:03.456Z'),
      nextAt: new Date('2026-01-01T04:02:03.456Z'),
    });
    expect(() =>
      parseScheduleRecurrence({ kind: 'interval', intervalMinutes: 0 }),
    ).toThrow(TypeError);
    expect(() =>
      parseScheduleRecurrence({ kind: 'interval', intervalMinutes: 43_201 }),
    ).toThrow(TypeError);
  });

  it('treats an occurrence equal to the supplied observation as due', () => {
    const recurrence = parseScheduleRecurrence({
      kind: 'interval',
      intervalMinutes: 5,
    });
    expect(
      resolveScheduleObservation(
        recurrence,
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-01-01T00:10:00.000Z'),
      ),
    ).toEqual({
      greatestDueAt: new Date('2026-01-01T00:10:00.000Z'),
      nextAt: new Date('2026-01-01T00:15:00.000Z'),
    });
  });
});
