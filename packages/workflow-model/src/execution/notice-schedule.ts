import { z } from 'zod';
import { ianaTimeZoneSchema } from '../values/json/time-zone.js';

export const noticeEmailModeSchema = z.enum([
  'off',
  'immediate',
  'hourly',
  'daily',
]);
export const noticeScheduleSchema = z
  .object({
    mode: noticeEmailModeSchema,
    hour: z.number().int().min(0).max(23),
    timeZone: ianaTimeZoneSchema,
  })
  .strict();

export type NoticeSchedule = z.output<typeof noticeScheduleSchema>;

const minute = 60_000;
function calendar(time: Date, zone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(time);
  const part = (name: string) =>
    Number(parts.find((p) => p.type === name)?.value);
  return Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
}
/** Resolve one local hour, choosing the first occurrence or first instant after a gap. */
function localHour(target: number, zone: string): number {
  const offsets = new Set<number>();
  for (let h = -36; h <= 36; h += 6) {
    const instant = target + h * 3_600_000;
    offsets.add(calendar(new Date(instant), zone) - instant);
  }
  const candidates = [...offsets]
    .map((offset) => target - offset)
    .sort((a, b) => a - b);
  const exact = candidates.filter(
    (instant) => calendar(new Date(instant), zone) === target,
  );
  if (exact.length > 0) return exact[0] ?? target;
  const above = candidates.find(
    (instant) => calendar(new Date(instant), zone) > target,
  );
  if (above === undefined)
    throw new RangeError('Unable to resolve the local notification hour');
  let low = (candidates[0] ?? above) - minute;
  let high = above;
  // At most 28 probes over the bounded 72-hour offset range, including skipped dates.
  while (high - low > 1000) {
    const middle = Math.floor((low + high) / 2000) * 1000;
    if (calendar(new Date(middle), zone) >= target) high = middle;
    else low = middle;
  }
  return high;
}
export function nextNoticeDue(
  schedule: NoticeSchedule,
  after: Date,
): Date | null {
  if (schedule.mode === 'off') return null;
  const now = after.getTime();
  if (schedule.mode === 'immediate')
    return new Date((Math.floor(now / minute) + 1) * minute);
  if (schedule.mode === 'hourly')
    return new Date((Math.floor(now / 3_600_000) + 1) * 3_600_000);
  const wall = new Date(calendar(after, schedule.timeZone));
  for (let day = 0; day < 4; day++) {
    const target = Date.UTC(
      wall.getUTCFullYear(),
      wall.getUTCMonth(),
      wall.getUTCDate() + day,
      schedule.hour,
    );
    const candidate = localHour(target, schedule.timeZone);
    if (candidate > now) return new Date(candidate);
  }
  throw new RangeError('Unable to schedule the next notification');
}
export function noticeWindow(schedule: NoticeSchedule, now: Date): string {
  if (schedule.mode === 'daily')
    return `daily:${new Date(calendar(now, schedule.timeZone)).toISOString().slice(0, 10)}`;
  return `${schedule.mode}:${now.toISOString().slice(0, schedule.mode === 'hourly' ? 13 : 16)}`;
}

export function nextPersonNoticeDue(
  pref: Readonly<{ nextDueAt: Date | null; scheduleDefaultRevision: number }>,
  current: Readonly<{
    defaultRevision: number;
    effective: NoticeSchedule;
    cut: Date;
  }>,
): Date | null {
  if (
    pref.nextDueAt !== null &&
    pref.scheduleDefaultRevision === current.defaultRevision
  ) {
    return pref.nextDueAt;
  }
  if (current.effective.mode === 'immediate') {
    return current.cut;
  }
  return nextNoticeDue(current.effective, current.cut);
}
