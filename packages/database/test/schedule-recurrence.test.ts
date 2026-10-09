import { describe, expect, it } from 'vitest';
import { CORE_SCHEDULE_CONFIG_SCHEMA } from '@pertexo/nodes-core';

import {
  parsePersistedScheduleRecurrence,
  parseScheduleRecurrence,
  resolveScheduleObservation,
  SCHEDULE_CRON_PARSER_VERSION,
} from '../src/triggers/schedule-recurrence.js';

describe('schedule recurrence', () => {
  it('translates mutually exclusive persisted recurrence columns strictly', () => {
    expect(
      parsePersistedScheduleRecurrence({
        recurrence_kind: 'cron',
        cron_expression: '30 9 * * 1-5',
        timezone: 'Europe/Paris',
        interval_minutes: null,
      }),
    ).toEqual({
      kind: 'cron',
      expression: '30 9 * * 1-5',
      timezone: 'Europe/Paris',
    });
    expect(
      parsePersistedScheduleRecurrence({
        recurrence_kind: 'interval',
        cron_expression: null,
        timezone: null,
        interval_minutes: 15,
      }),
    ).toEqual({ kind: 'interval', intervalMinutes: 15 });
    expect(() =>
      parsePersistedScheduleRecurrence({
        recurrence_kind: 'cron',
        cron_expression: null,
        timezone: 'Europe/Paris',
        interval_minutes: null,
      }),
    ).toThrow(TypeError);
    expect(() =>
      parsePersistedScheduleRecurrence({
        recurrence_kind: 'interval',
        cron_expression: null,
        timezone: null,
        interval_minutes: null,
      }),
    ).toThrow(TypeError);
  });

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
      { kind: 'cron', expression: '0\t 9 * * *', timezone: 'Europe/Paris' },
      { kind: 'cron', expression: '0 \t9 * * *', timezone: 'Europe/Paris' },
      { kind: 'cron', expression: '0\n 9 * * *', timezone: 'Europe/Paris' },
    ]) {
      expect(() => parseScheduleRecurrence(input)).toThrow(TypeError);
    }
  });

  it('keeps node and recurrence acceptance aligned', () => {
    const longExpression = `${Array(150).fill('0').join(',')} * * * *`;
    const corpus = [
      { kind: 'cron', expression: '0 9 * * 1', timezone: 'Europe/Paris' },
      { kind: 'cron', expression: longExpression, timezone: 'Europe/Paris' },
      { kind: 'cron', expression: '0 9 * * 1', timezone: 'Etc/GMT+1' },
      { kind: 'cron', expression: '0 9 * * 1', timezone: 'UTC' },
      { kind: 'interval', intervalMinutes: 1 },
      { kind: 'interval', intervalMinutes: 43_201 },
    ] as const;
    for (const recurrence of corpus) {
      const node = CORE_SCHEDULE_CONFIG_SCHEMA.safeParse({
        ...recurrence,
        misfirePolicy: 'catch_up_once',
      });
      if (node.success)
        expect(parseScheduleRecurrence(recurrence)).toMatchObject(recurrence);
      else expect(() => parseScheduleRecurrence(recurrence)).toThrow(TypeError);
    }
    expect(
      CORE_SCHEDULE_CONFIG_SCHEMA.safeParse({
        kind: 'cron',
        expression: '0 9 ? * 1',
        timezone: 'Europe/Paris',
        misfirePolicy: 'catch_up_once',
      }).success,
    ).toBe(false);
  });

  it('materializes an accepted cron recurrence and refuses unsupported tokens', () => {
    const accepted = CORE_SCHEDULE_CONFIG_SCHEMA.parse({
      kind: 'cron',
      expression: '0 9 * * 1',
      timezone: 'Europe/Paris',
      misfirePolicy: 'skip',
    });
    expect(
      parsePersistedScheduleRecurrence({
        recurrence_kind: 'cron',
        cron_expression: accepted.kind === 'cron' ? accepted.expression : null,
        timezone: accepted.kind === 'cron' ? accepted.timezone : null,
        interval_minutes: null,
      }),
    ).toEqual({
      kind: 'cron',
      expression: '0 9 * * 1',
      timezone: 'Europe/Paris',
    });
    expect(() =>
      parseScheduleRecurrence({
        kind: 'cron',
        expression: '0 9 ? * 1',
        timezone: 'Europe/Paris',
      }),
    ).toThrow(TypeError);
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
