import { describe, expect, it } from 'vitest';

import {
  MAX_SCHEDULE_PROJECTION,
  parseScheduleRecurrence,
  projectScheduleOccurrences,
  resolveScheduleObservation,
  type ScheduleRecurrence,
} from '../src/triggers/schedule-recurrence.js';

function project(
  recurrence: ScheduleRecurrence,
  anchorAt: string,
  observedAt: string,
  count = 3,
): readonly string[] {
  return projectScheduleOccurrences(
    recurrence,
    new Date(anchorAt),
    new Date(observedAt),
    count,
  ).map((instant) => instant.toISOString());
}

function cron(expression: string, timezone: string): ScheduleRecurrence {
  return parseScheduleRecurrence({ kind: 'cron', expression, timezone });
}

describe('schedule fire-time projection', () => {
  it('starts one interval after a fresh anchor and never drifts from it', () => {
    const recurrence = parseScheduleRecurrence({
      kind: 'interval',
      intervalMinutes: 90,
    });
    expect(
      project(
        recurrence,
        '2026-01-01T00:00:07.250Z',
        '2026-01-01T00:00:07.250Z',
      ),
    ).toEqual([
      '2026-01-01T01:30:07.250Z',
      '2026-01-01T03:00:07.250Z',
      '2026-01-01T04:30:07.250Z',
    ]);
    // Mid-interval observations continue from the anchor, not the observation.
    expect(
      project(
        recurrence,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T02:10:00.000Z',
        2,
      ),
    ).toEqual(['2026-01-01T03:00:00.000Z', '2026-01-01T04:30:00.000Z']);
  });

  it('counts elapsed time for intervals across a DST change', () => {
    const recurrence = parseScheduleRecurrence({
      kind: 'interval',
      intervalMinutes: 60,
    });
    // 2026-03-08 is the New York spring-forward day; UTC spacing is unchanged.
    expect(
      project(
        recurrence,
        '2026-03-08T05:30:00.000Z',
        '2026-03-08T05:30:00.000Z',
      ),
    ).toEqual([
      '2026-03-08T06:30:00.000Z',
      '2026-03-08T07:30:00.000Z',
      '2026-03-08T08:30:00.000Z',
    ]);
  });

  it('moves a local time that the spring gap skips to the first valid instant, once', () => {
    expect(
      project(
        cron('30 2 * * *', 'America/New_York'),
        '2026-03-07T12:00:00.000Z',
        '2026-03-07T12:00:00.000Z',
      ),
    ).toEqual([
      // 02:30 does not exist on 8 March; 03:00 EDT is the first valid instant.
      '2026-03-08T07:00:00.000Z',
      '2026-03-09T06:30:00.000Z',
      '2026-03-10T06:30:00.000Z',
    ]);
  });

  it('fires a local time repeated by the autumn change once, at the earlier instant', () => {
    expect(
      project(
        cron('30 1 * * *', 'America/New_York'),
        '2026-10-31T12:00:00.000Z',
        '2026-10-31T12:00:00.000Z',
      ),
    ).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
      '2026-11-03T06:30:00.000Z',
    ]);
  });

  it('skips the repeated hour of an hourly rule instead of running it twice', () => {
    // 00:30Z is 02:30 CEST; the clocks go back at 01:00Z to 02:00 CET, a
    // local hour that already fired at 00:00Z.
    expect(
      project(
        cron('0 * * * *', 'Europe/Berlin'),
        '2026-10-25T00:30:00.000Z',
        '2026-10-25T00:30:00.000Z',
      ),
    ).toEqual([
      '2026-10-25T02:00:00.000Z',
      '2026-10-25T03:00:00.000Z',
      '2026-10-25T04:00:00.000Z',
    ]);
    expect(
      project(
        cron('0 * * * *', 'Europe/Berlin'),
        '2026-03-29T00:30:00.000Z',
        '2026-03-29T00:30:00.000Z',
      ),
    ).toEqual([
      '2026-03-29T01:00:00.000Z',
      '2026-03-29T02:00:00.000Z',
      '2026-03-29T03:00:00.000Z',
    ]);
  });

  it('follows a half-hour DST shift without assuming whole hours', () => {
    expect(
      project(
        cron('*/30 * * * *', 'Australia/Lord_Howe'),
        '2026-04-04T14:10:00.000Z',
        '2026-04-04T14:10:00.000Z',
        4,
      ),
    ).toEqual([
      '2026-04-04T14:30:00.000Z',
      '2026-04-04T15:30:00.000Z',
      '2026-04-04T16:00:00.000Z',
      '2026-04-04T16:30:00.000Z',
    ]);
  });

  it('collapses every minute inside a spring gap into one run', () => {
    expect(
      project(
        cron('* 2 * * *', 'America/New_York'),
        '2026-03-08T06:00:00.000Z',
        '2026-03-08T06:00:00.000Z',
        MAX_SCHEDULE_PROJECTION,
      ).slice(0, 3),
    ).toEqual([
      '2026-03-08T07:00:00.000Z',
      '2026-03-09T06:00:00.000Z',
      '2026-03-09T06:01:00.000Z',
    ]);
  });

  it('is exactly the chain of instants the scanner persists', () => {
    const recurrence = cron('0 9 * * 1-5', 'Europe/London');
    const anchorAt = new Date('2026-03-20T10:00:00.000Z');
    let cursor = new Date('2026-03-27T12:00:00.000Z');
    const persisted: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      cursor = resolveScheduleObservation(recurrence, anchorAt, cursor).nextAt;
      persisted.push(cursor.toISOString());
    }
    expect(
      project(
        recurrence,
        anchorAt.toISOString(),
        '2026-03-27T12:00:00.000Z',
        5,
      ),
    ).toEqual(persisted);
    // British Summer Time starts on 29 March: 09:00 moves from 09:00Z to 08:00Z.
    expect(persisted).toEqual([
      '2026-03-30T08:00:00.000Z',
      '2026-03-31T08:00:00.000Z',
      '2026-04-01T08:00:00.000Z',
      '2026-04-02T08:00:00.000Z',
      '2026-04-03T08:00:00.000Z',
    ]);
  });

  it('rejects unbounded counts and recurrences the scheduler would reject', () => {
    const recurrence = cron('0 9 * * *', 'Europe/Paris');
    for (const count of [0, MAX_SCHEDULE_PROJECTION + 1, 1.5, Number.NaN])
      expect(() =>
        projectScheduleOccurrences(recurrence, new Date(), new Date(), count),
      ).toThrow(RangeError);
    expect(() =>
      projectScheduleOccurrences(
        { kind: 'cron', expression: '0 9 * * *', timezone: 'Etc/GMT+2' },
        new Date(),
        new Date(),
        1,
      ),
    ).toThrow(TypeError);
    expect(() =>
      projectScheduleOccurrences(
        recurrence,
        new Date(Number.NaN),
        new Date(),
        1,
      ),
    ).toThrow(TypeError);
  });
});
