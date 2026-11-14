import { z } from 'zod';
import { ianaTimeZoneSchema } from '../values/time-zone.schemas.js';

const LAST_HOUR_OF_DAY = 23;
const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
// Every zone's offset lies within this many hours of UTC; probe it in steps.
const OFFSET_PROBE_HOURS = 36;
const OFFSET_PROBE_STEP_HOURS = 6;
// Skipped dates mean the next local hour can be up to this many days away.
const DAILY_CANDIDATE_DAYS = 4;
// Window keys: the ISO date, hour and minute prefixes of an instant.
const ISO_DATE_LENGTH = 10;
const ISO_HOUR_LENGTH = 13;
const ISO_MINUTE_LENGTH = 16;

export const noticeEmailModeSchema = z.enum([
  'off',
  'immediate',
  'hourly',
  'daily',
]);
export const noticeScheduleSchema = z
  .object({
    mode: noticeEmailModeSchema,
    hour: z.number().int().min(0).max(LAST_HOUR_OF_DAY),
    timeZone: ianaTimeZoneSchema,
  })
  .strict();

export type NoticeSchedule = z.output<typeof noticeScheduleSchema>;

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
  for (
    let h = -OFFSET_PROBE_HOURS;
    h <= OFFSET_PROBE_HOURS;
    h += OFFSET_PROBE_STEP_HOURS
  ) {
    const instant = target + h * HOUR_MS;
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
  let low = (candidates[0] ?? above) - MINUTE_MS;
  let high = above;
  // At most 28 probes over the bounded 72-hour offset range, including skipped dates.
  while (high - low > SECOND_MS) {
    const middle = Math.floor((low + high) / 2 / SECOND_MS) * SECOND_MS;
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
    return new Date((Math.floor(now / MINUTE_MS) + 1) * MINUTE_MS);
  if (schedule.mode === 'hourly')
    return new Date((Math.floor(now / HOUR_MS) + 1) * HOUR_MS);
  const wall = new Date(calendar(after, schedule.timeZone));
  for (let day = 0; day < DAILY_CANDIDATE_DAYS; day++) {
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
    return `daily:${new Date(calendar(now, schedule.timeZone)).toISOString().slice(0, ISO_DATE_LENGTH)}`;
  return `${schedule.mode}:${now.toISOString().slice(0, schedule.mode === 'hourly' ? ISO_HOUR_LENGTH : ISO_MINUTE_LENGTH)}`;
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
