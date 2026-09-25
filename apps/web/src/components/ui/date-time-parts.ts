// Local calendar dates and wall-clock times for the date-time field. Values
// use the same text shape as a native `datetime-local` input
// ("2026-09-25T14:30"), read in the person's own time zone.

/** A local calendar day, `YYYY-MM-DD`. */
export type LocalDate = string;

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function localDateOf(date: Date): LocalDate {
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The local midnight of a `YYYY-MM-DD` day, or undefined if it isn't one. */
export function dateOf(value: string): Date | undefined {
  const match = LOCAL_DATE.exec(value);
  if (match === null) return undefined;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(year, month - 1, day);
  return date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : undefined;
}

export function shiftDays(value: LocalDate, days: number): LocalDate {
  const date = dateOf(value) ?? new Date();
  return localDateOf(
    new Date(date.getFullYear(), date.getMonth(), date.getDate() + days),
  );
}

/** The same day in another month, or that month's last day if it's shorter. */
export function shiftMonths(value: LocalDate, months: number): LocalDate {
  const date = dateOf(value) ?? new Date();
  const lastDay = new Date(
    date.getFullYear(),
    date.getMonth() + months + 1,
    0,
  ).getDate();
  return localDateOf(
    new Date(
      date.getFullYear(),
      date.getMonth() + months,
      Math.min(date.getDate(), lastDay),
    ),
  );
}

/** Monday-first weeks covering the month that contains `value`. */
export function monthWeeks(
  value: LocalDate,
): readonly (readonly LocalDate[])[] {
  const date = dateOf(value) ?? new Date();
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(
    date.getFullYear(),
    date.getMonth() + 1,
    0,
  ).getDate();
  const weeks: LocalDate[][] = [];
  const cells = Math.ceil((lead + daysInMonth) / 7) * 7;
  for (let cell = 0; cell < cells; cell += 1) {
    if (cell % 7 === 0) weeks.push([]);
    weeks
      .at(-1)
      ?.push(
        localDateOf(
          new Date(first.getFullYear(), first.getMonth(), 1 - lead + cell),
        ),
      );
  }
  return weeks;
}

export function sameMonth(left: LocalDate, right: LocalDate): boolean {
  return left.slice(0, 7) === right.slice(0, 7);
}

/**
 * Typed times people write: "9" → 09:00, "930" → 09:30, "21:5" → 21:05.
 * Undefined when it isn't a time of day.
 */
export function normalizeClock(text: string): string | undefined {
  const trimmed = text.trim();
  const match =
    /^(\d{1,2})(?::(\d{1,2}))?$/u.exec(trimmed) ??
    /^(\d{1,2})(\d{2})$/u.exec(trimmed);
  if (match === null) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  if (hours > 23 || minutes > 59) return undefined;
  return `${pad(hours)}:${pad(minutes)}`;
}

export function splitDateTime(
  value: string,
): Readonly<{ date: string; time: string }> {
  const [date = '', time = ''] = value.split('T');
  return { date, time };
}

export function joinDateTime(date: string, time: string): string {
  return date === '' && time === '' ? '' : `${date}T${time}`;
}

/** A sensible time for a newly picked day: the next full hour today, else 09:00. */
export function defaultClock(date: LocalDate, now = new Date()): string {
  if (date !== localDateOf(now)) return '09:00';
  const next = Math.min(now.getHours() + 1, 23);
  return `${pad(next)}:00`;
}
