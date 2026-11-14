import { addDuration } from './add-duration.js';
import { formatInstant } from './format-instant.js';
import { NodeInputValidationError } from '@pertexo/node-sdk/server';
import type { CoreDateConfig, CoreDateInput } from './date.schemas.js';

const CALENDAR = Object.freeze({
  months: 12,
  lastHour: 23,
  lastMinute: 59,
  lastSecond: 59,
});
const LEAP_YEARS = Object.freeze({
  every: 4,
  exceptCenturies: 100,
  butEvery: 400,
});
const FEBRUARY = 2;
const FEBRUARY_DAYS = Object.freeze({ common: 28, leap: 29 });
const MONTH_DAYS: readonly number[] = Object.freeze([
  31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
]);
// An offset `+HH:MM`: hours at 1–3, minutes from 4.
const OFFSET_HOURS = Object.freeze({ start: 1, end: 3 });
const OFFSET_MINUTES_START = 4;

const MIN_INSTANT = -62_167_219_200_000;
const MAX_INSTANT = 253_402_300_799_999;
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;
// What date columns and date pickers produce; read as midnight UTC.
const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
function invalidDate(): never {
  throw new NodeInputValidationError(
    'Use a date like 2026-10-19, a time with its offset like 2026-10-19T09:30:00+02:00, or epoch milliseconds, within the years 0000 to 9999.',
  );
}
function checkInstant(value: number): number {
  if (!Number.isInteger(value) || value < MIN_INSTANT || value > MAX_INSTANT)
    return invalidDate();
  return value;
}
function parseInstant(value: string): number {
  const plain = PLAIN_DATE.exec(value);
  const parts = INSTANT.exec(plain === null ? value : `${value}T00:00:00Z`);
  if (parts === null) return invalidDate();
  const year = Number(parts[1]),
    month = Number(parts[2]),
    day = Number(parts[3]);
  const hour = Number(parts[4]),
    minute = Number(parts[5]),
    second = Number(parts[6]);
  const offset = String(parts[8]);
  const daysInMonth = daysInMonthOf(year, month);
  const invalidParts =
    month < 1 ||
    month > CALENDAR.months ||
    day < 1 ||
    daysInMonth === undefined ||
    day > daysInMonth ||
    hour > CALENDAR.lastHour ||
    minute > CALENDAR.lastMinute ||
    second > CALENDAR.lastSecond ||
    (offset !== 'Z' &&
      (Number(offset.slice(OFFSET_HOURS.start, OFFSET_HOURS.end)) >
        CALENDAR.lastHour ||
        Number(offset.slice(OFFSET_MINUTES_START)) > CALENDAR.lastMinute));
  if (invalidParts) return invalidDate();
  return checkInstant(Date.parse(parts[0]));
}
export function transformDateValue(
  config: CoreDateConfig,
  input: CoreDateInput,
) {
  if (config.operation === 'to_iso') {
    const instant =
      typeof input.value === 'number'
        ? checkInstant(input.value)
        : parseInstant(input.value);
    return { value: new Date(instant).toISOString() };
  }
  if (config.operation === 'to_epoch_millis') {
    if (typeof input.value !== 'string') return invalidDate();
    return { value: parseInstant(input.value) };
  }
  const instant =
    typeof input.value === 'number'
      ? checkInstant(input.value)
      : parseInstant(input.value);
  if (config.operation === 'format')
    return { value: formatInstant(instant, config.timeZone, config.format) };
  if (config.operation === 'convert_timezone')
    return { value: formatInstant(instant, config.timeZone, 'iso') };
  if (input.amount === undefined)
    throw new NodeInputValidationError(
      'Add duration requires a signed integer amount',
    );
  return {
    value: new Date(
      checkInstant(addDuration(instant, input.amount, config.unit)),
    ).toISOString(),
  };
}

/** Days in a Gregorian month: leap years are divisible by 4, except centuries not divisible by 400. */
function daysInMonthOf(year: number, month: number): number | undefined {
  const leap =
    year % LEAP_YEARS.every === 0 &&
    (year % LEAP_YEARS.exceptCenturies !== 0 ||
      year % LEAP_YEARS.butEvery === 0);
  if (month === FEBRUARY)
    return leap ? FEBRUARY_DAYS.leap : FEBRUARY_DAYS.common;
  return MONTH_DAYS[month - 1];
}
