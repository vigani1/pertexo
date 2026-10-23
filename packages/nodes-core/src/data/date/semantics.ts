import { addDuration } from './add-duration.js';
import { formatInstant } from './format-instant.js';
import { NodeInputValidationError } from '@pertexo/node-sdk/server';
import type { CoreDateConfig, CoreDateInput } from './validation.js';

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
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const daysInMonth = days[month - 1];
  const invalidParts =
    month < 1 ||
    month > 12 ||
    day < 1 ||
    daysInMonth === undefined ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (offset !== 'Z' &&
      (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59));
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
