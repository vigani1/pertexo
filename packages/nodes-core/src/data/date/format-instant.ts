import { NodeInputValidationError } from '@pertexo/node-sdk/server';

// ISO 8601 without an expanded year: four digits, so years 0000 to 9999.
const ISO_YEAR_DIGITS = 4;
const LAST_ISO_YEAR = 9999;
const MILLISECOND_DIGITS = 3;
type Format = 'date_only' | 'date_time' | 'iso';
export function formatInstant(
  instant: number,
  timeZone: string,
  format: Format,
): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    hourCycle: 'h23',
    era: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: MILLISECOND_DIGITS,
    timeZoneName: 'longOffset',
  });
  const parts = new Map(
    formatter
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  // The fixed formatter options supply these parts; no locale-dependent string parsing.
  const part = (key: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.get(key);
    if (value === undefined)
      throw new Error('The fixed Intl formatter omitted a required date part');
    return value;
  };
  const year =
    part('era') === 'BC' ? 1 - Number(part('year')) : Number(part('year'));
  if (year < 0 || year > LAST_ISO_YEAR)
    throw new NodeInputValidationError(
      `The local date must stay within years 0000 through ${String(LAST_ISO_YEAR)}`,
    );
  const date = `${String(year).padStart(ISO_YEAR_DIGITS, '0')}-${part('month')}-${part('day')}`;
  if (format === 'date_only') return date;
  const time = `${part('hour')}:${part('minute')}:${part('second')}`;
  if (format === 'date_time') return `${date} ${time}`;
  const offset = part('timeZoneName');
  if (!/^GMT(?:[+-]\d{2}:\d{2})?$/u.test(offset))
    throw new NodeInputValidationError(
      'This historical timezone offset cannot be represented by a minute-offset ISO timestamp; use a display format or another timezone',
    );
  return `${date}T${time}.${part('fractionalSecond')}${/^GMT(?:[+-]00:00)?$/u.test(offset) ? 'Z' : offset.slice('GMT'.length)}`;
}
