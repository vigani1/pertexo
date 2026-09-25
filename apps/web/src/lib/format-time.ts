// Shared, locale-aware time formatting. Inputs are ISO strings from the API
// or epoch milliseconds; missing values render as an em dash.

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
});
const clockFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const shortTimeFormatter = new Intl.DateTimeFormat(undefined, {
  timeStyle: 'short',
});
const dayHeadingFormatter = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
});
const relativeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto',
  style: 'short',
});

const MISSING = '—';

function toDate(value: string | number | null | undefined): Date | undefined {
  if (value === null || value === undefined) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function formatDateTime(value: string | null | undefined): string {
  const date = toDate(value);
  return date === undefined ? MISSING : dateTimeFormatter.format(date);
}

export function formatDate(value: string | null | undefined): string {
  const date = toDate(value);
  return date === undefined ? MISSING : dateFormatter.format(date);
}

/** Wall-clock time with seconds, e.g. 14:31:02. */
export function formatClock(value: string | null | undefined): string {
  const date = toDate(value);
  return date === undefined ? MISSING : clockFormatter.format(date);
}

/**
 * Wall-clock time to the minute in the person's locale, e.g. 14:31 or
 * 2:31 PM: when something last happened, where seconds are noise.
 */
export function formatShortTime(
  value: string | number | null | undefined,
): string {
  const date = toDate(value);
  return date === undefined ? MISSING : shortTimeFormatter.format(date);
}

/** "Today", "Yesterday" or "24 Sep" for grouping lists by day. */
export function formatDayHeading(value: string, now = Date.now()): string {
  const date = toDate(value);
  if (date === undefined) return MISSING;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 86_400_000;
  if (date.getTime() >= startOfToday.getTime()) return 'Today';
  if (date.getTime() >= startOfToday.getTime() - dayMs) return 'Yesterday';
  return dayHeadingFormatter.format(date);
}

/** "12 min ago", "in 3 hr". */
export function formatRelativeTime(
  value: string | null | undefined,
  now = Date.now(),
): string {
  const date = toDate(value);
  if (date === undefined) return MISSING;
  const seconds = Math.round((date.getTime() - now) / 1000);
  const magnitude = Math.abs(seconds);
  if (magnitude < 45) return 'just now';
  if (magnitude < 3_600)
    return relativeFormatter.format(Math.round(seconds / 60), 'minute');
  if (magnitude < 86_400)
    return relativeFormatter.format(Math.round(seconds / 3_600), 'hour');
  return relativeFormatter.format(Math.round(seconds / 86_400), 'day');
}

/** Compact duration: 0.12 s, 4.2 s, 1m 12s, 2h 05m. */
export function formatDurationMs(
  durationMs: number | null | undefined,
): string {
  if (durationMs === null || durationMs === undefined || durationMs < 0)
    return MISSING;
  if (durationMs < 1_000) return `${(durationMs / 1_000).toFixed(2)} s`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`;
  const totalSeconds = Math.floor(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0)
    return `${String(hours)}h ${String(minutes).padStart(2, '0')}m`;
  return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`;
}

/** "0:24", "4:59" — the instrument voice for a countdown in whole seconds. */
export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${String(seconds % 60).padStart(2, '0')}`;
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Weekday, date and time on a named place's clock, with that clock's own
 * zone name so a daylight-saving change shows: "Sun, 8 Mar, 03:00 EDT" for
 * `America/New_York`. Invalid zones render a dash.
 */
export function formatDateTimeInZone(
  value: string | null | undefined,
  timeZone: string,
): string {
  const date = toDate(value);
  if (date === undefined) return MISSING;
  let formatter = zonedFormatters.get(timeZone);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
        timeZone,
      });
    } catch {
      return MISSING;
    }
    zonedFormatters.set(timeZone, formatter);
  }
  return formatter.format(date);
}

/** The person's IANA time zone, e.g. `Europe/Berlin`. */
export function localTimeZone(): string {
  return dateTimeFormatter.resolvedOptions().timeZone;
}

/** "UTC+2" or "UTC−3:30", from the browser's current offset. */
export function localUtcOffset(date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '−';
  const hours = Math.floor(Math.abs(offsetMinutes) / 60);
  const minutes = Math.abs(offsetMinutes) % 60;
  return `UTC${sign}${String(hours)}${minutes === 0 ? '' : `:${String(minutes).padStart(2, '0')}`}`;
}

const calendarDayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const monthYearFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
});
const weekdayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
});

/** A calendar day spelled out: "Friday, 25 September 2026". */
export function formatCalendarDay(date: Date): string {
  return calendarDayFormatter.format(date);
}

/** A calendar's month heading: "September 2026". */
export function formatMonthYear(date: Date): string {
  return monthYearFormatter.format(date);
}

/** Short weekday names from Monday: "Mon" … "Sun". */
export function weekdayNames(): readonly string[] {
  // 2024-01-01 was a Monday.
  return Array.from({ length: 7 }, (_, day) =>
    weekdayFormatter.format(new Date(2024, 0, 1 + day)),
  );
}
