import { nextNoticeDue, noticeWindow } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';
const daily = (timeZone: string, hour = 9) => ({
  mode: 'daily' as const,
  timeZone,
  hour,
});
describe('personal mail schedule', () => {
  it.each([
    ['UTC', 9, '2026-10-15T08:59:59Z', '2026-10-15T09:00:00.000Z'],
    ['UTC', 9, '2026-10-15T09:00:00Z', '2026-10-16T09:00:00.000Z'],
    ['Asia/Kathmandu', 9, '2026-10-15T00:00:00Z', '2026-10-15T03:15:00.000Z'],
    ['America/New_York', 2, '2026-03-08T06:00:00Z', '2026-03-08T07:00:00.000Z'],
    ['America/New_York', 1, '2026-11-01T04:30:00Z', '2026-11-01T05:00:00.000Z'],
    ['America/New_York', 1, '2026-11-01T05:30:00Z', '2026-11-02T06:00:00.000Z'],
    [
      'Australia/Lord_Howe',
      2,
      '2026-10-03T12:00:00Z',
      '2026-10-03T15:30:00.000Z',
    ],
    ['Pacific/Apia', 9, '2011-12-29T21:00:00Z', '2011-12-30T10:00:00.000Z'],
    ['UTC', 0, '2028-02-28T23:00:00Z', '2028-02-29T00:00:00.000Z'],
  ] as const)('resolves %s hour %i after %s', (zone, hour, after, expected) => {
    expect(
      nextNoticeDue(daily(zone, hour), new Date(after))?.toISOString(),
    ).toBe(expected);
  });
  it('uses the next UTC hour/minute and does not schedule Off', () => {
    const observed = new Date('2026-10-15T10:20:30.123Z');
    expect(
      nextNoticeDue(
        { mode: 'hourly', hour: 9, timeZone: 'Pacific/Auckland' },
        observed,
      )?.toISOString(),
    ).toBe('2026-10-15T11:00:00.000Z');
    expect(
      nextNoticeDue(
        { mode: 'immediate', hour: 9, timeZone: 'Pacific/Auckland' },
        observed,
      )?.toISOString(),
    ).toBe('2026-10-15T10:21:00.000Z');
    expect(
      nextNoticeDue({ mode: 'off', hour: 9, timeZone: 'UTC' }, observed),
    ).toBeNull();
  });
  it('reserves a repeated local day once and catches up in the current window', () => {
    const schedule = daily('America/New_York', 1);
    expect(noticeWindow(schedule, new Date('2026-11-01T05:00:00Z'))).toBe(
      noticeWindow(schedule, new Date('2026-11-01T06:00:00Z')),
    );
    expect(
      noticeWindow(
        { mode: 'hourly', hour: 9, timeZone: 'UTC' },
        new Date('2026-10-15T10:45:00Z'),
      ),
    ).toBe('hourly:2026-10-15T10');
  });
});
