import type { ScheduleTriggerHealthResponse } from '@pertexo/contracts/schemas/schedules';

// How the Schedule step's rule reads to people. It lives with the rest of the
// step presentation so the editor's builder and the published trigger cards
// say the same thing.

type Recurrence = ScheduleTriggerHealthResponse['recurrence'];

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
const DAY_ALIASES: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};
const MONTH_ALIASES: Readonly<Record<string, number>> = Object.fromEntries(
  MONTH_NAMES.map((name, index) => [name.slice(0, 3).toLowerCase(), index + 1]),
);

/** "Every 15 minutes", "Every 2 hours", "Every 3 days", "Every week". */
export function describeInterval(minutes: number): string {
  const every = (count: number, one: string, many: string) =>
    count === 1 ? `Every ${one}` : `Every ${String(count)} ${many}`;
  if (minutes % 10_080 === 0) return every(minutes / 10_080, 'week', 'weeks');
  if (minutes >= 2_880 && minutes % 1_440 === 0)
    return every(minutes / 1_440, 'day', 'days');
  if (minutes % 60 === 0) return every(minutes / 60, 'hour', 'hours');
  return every(minutes, 'minute', 'minutes');
}

type Field = Readonly<{ any: boolean; step?: number; values: number[] }>;

function toNumber(
  token: string,
  aliases: Readonly<Record<string, number>>,
): number | undefined {
  const alias = aliases[token.toLowerCase()];
  if (alias !== undefined) return alias;
  return /^\d+$/u.test(token) ? Number(token) : undefined;
}

/** One cron field as the values it allows; undefined when unreadable. */
function parseField(
  source: string,
  min: number,
  max: number,
  aliases: Readonly<Record<string, number>> = {},
): Field | undefined {
  if (source === '*') return { any: true, values: [] };
  const values = new Set<number>();
  let step: number | undefined;
  for (const part of source.split(',')) {
    const [range = '', stepText] = part.split('/');
    const size = stepText === undefined ? 1 : toNumber(stepText, {});
    if (size === undefined || size < 1) return undefined;
    const [startText = '', endText] =
      range === '*' ? [String(min), String(max)] : range.split('-');
    const start = toNumber(startText, aliases);
    const end =
      endText === undefined
        ? stepText === undefined
          ? start
          : max
        : toNumber(endText, aliases);
    if (start === undefined || end === undefined || start < min || end > max)
      return undefined;
    for (let value = start; value <= end; value += size) values.add(value);
    if (range === '*' && stepText !== undefined) step = size;
  }
  return {
    any: false,
    ...(step === undefined || source.includes(',') ? {} : { step }),
    values: [...values].sort((a, b) => a - b),
  };
}

function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`;
}

const pad = (value: number) => String(value).padStart(2, '0');

function ordinal(day: number): string {
  const teen = day % 100 >= 11 && day % 100 <= 13;
  const suffix = teen ? 'th' : (['th', 'st', 'nd', 'rd'][day % 10] ?? 'th');
  return `${String(day)}${suffix}`;
}

/** "every weekday", "every Monday and Thursday", or undefined for any day. */
function describeWeekdays(field: Field): string | undefined {
  if (field.any) return undefined;
  const days = [...new Set(field.values.map((day) => day % 7))].sort(
    (a, b) => a - b,
  );
  if (days.join() === '1,2,3,4,5') return 'every weekday';
  if (days.join() === '0,6') return 'every Saturday and Sunday';
  return `every ${listWords(days.map((day) => DAY_NAMES[day] ?? ''))}`;
}

function describeDays(
  dayOfMonth: Field,
  month: Field,
  weekday: Field,
): string | undefined {
  if (!dayOfMonth.any && !weekday.any) return undefined;
  const months = month.any
    ? undefined
    : listWords(month.values.map((value) => MONTH_NAMES[value - 1] ?? ''));
  if (!dayOfMonth.any) {
    const days = listWords(dayOfMonth.values.map(ordinal));
    return months === undefined
      ? `on the ${days} of every month`
      : `on the ${days} of ${months}`;
  }
  const weekdays = describeWeekdays(weekday);
  if (months === undefined) return weekdays ?? 'every day';
  return `${weekdays ?? 'every day'} in ${months}`;
}

function describeTimes(minute: Field, hour: Field): string | undefined {
  if (minute.any && hour.any) return 'Every minute';
  if (minute.step !== undefined && hour.any)
    return `Every ${String(minute.step)} minutes`;
  const [onlyMinute] = minute.values;
  if (minute.values.length !== 1 || onlyMinute === undefined) return undefined;
  if (hour.any) return `Every hour at :${pad(onlyMinute)}`;
  if (hour.step !== undefined)
    return `Every ${String(hour.step)} hours at :${pad(onlyMinute)}`;
  if (hour.values.length > 4) return undefined;
  return `at ${listWords(hour.values.map((value) => `${pad(value)}:${pad(onlyMinute)}`))}`;
}

/**
 * A five-field cron expression as a sentence, e.g. "Every weekday at 09:00".
 * Shapes it can't say plainly fall back to naming the expression itself.
 */
export function describeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/u);
  const fallback = `On a custom schedule (${expression.trim()})`;
  if (fields.length !== 5) return fallback;
  const [minute, hour, dayOfMonth, month, weekday] = [
    parseField(fields[0] ?? '', 0, 59),
    parseField(fields[1] ?? '', 0, 23),
    parseField(fields[2] ?? '', 1, 31),
    parseField(fields[3] ?? '', 1, 12, MONTH_ALIASES),
    parseField(fields[4] ?? '', 0, 7, DAY_ALIASES),
  ];
  if (!minute || !hour || !dayOfMonth || !month || !weekday) return fallback;
  const times = describeTimes(minute, hour);
  const days = describeDays(dayOfMonth, month, weekday);
  if (times === undefined || days === undefined) return fallback;
  if (times.startsWith('at ')) {
    const sentence = `${days} ${times}`;
    return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
  }
  return days === 'every day' ? times : `${times}, ${days}`;
}

export function describeRecurrence(recurrence: Recurrence): string {
  return recurrence.kind === 'interval'
    ? describeInterval(recurrence.intervalMinutes)
    : describeCron(recurrence.expression);
}

export function describeMisfirePolicy(
  policy: ScheduleTriggerHealthResponse['misfirePolicy'],
): string {
  return policy === 'catch_up_once'
    ? 'If a run is missed, it runs once as soon as Pertexo can.'
    : 'If a run is missed, it’s skipped and the next one runs on time.';
}
