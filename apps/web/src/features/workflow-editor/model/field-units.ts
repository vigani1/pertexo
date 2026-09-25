import { formatByteLength } from '@/lib/format-bytes';

// Setup fields in people's words and units. Catalog schemas name settings
// like `timeoutMillis` or `maxResponseBytes`; the Setup tab reads them as
// "Timeout" in seconds and "Largest response" with its size in words,
// while the step's config keeps the exact stored value and unit.

export type FieldUnit = 'milliseconds' | 'seconds' | 'bytes';

const UNIT_SUFFIXES: readonly Readonly<{ suffix: RegExp; unit: FieldUnit }>[] =
  [
    { suffix: /(?:Millis|Ms|Milliseconds)$/u, unit: 'milliseconds' },
    { suffix: /(?:Seconds|Secs)$/u, unit: 'seconds' },
    { suffix: /Bytes$/u, unit: 'bytes' },
  ];

/** Names for settings whose key alone reads poorly. */
const KNOWN_LABELS: Readonly<Record<string, string>> = {
  timeoutMillis: 'Timeout',
  durationSeconds: 'Wait for',
  maxRedirects: 'Redirects to follow',
  maxResponseBytes: 'Largest response',
  inlineResponseBytes: 'Largest inline output',
  maxConcurrency: 'Branches at once',
};

const ACRONYMS: Readonly<Record<string, string>> = {
  url: 'URL',
  id: 'ID',
  http: 'HTTP',
  api: 'API',
};

/** The unit a number setting's key names, if any. */
export function fieldUnit(key: string): FieldUnit | undefined {
  return UNIT_SUFFIXES.find(({ suffix }) => suffix.test(key))?.unit;
}

/**
 * A setting's label from its key when the schema gives no title:
 * `timeoutMillis` → "Timeout", `max_items` → "Max items", `url` → "URL".
 * A unit at the end of the key is left to the field, which shows it.
 */
export function fieldLabel(key: string): string {
  const known = KNOWN_LABELS[key];
  if (known !== undefined) return known;
  const unitless =
    UNIT_SUFFIXES.reduce(
      (current, { suffix }) => current.replace(suffix, ''),
      key,
    ) || key;
  const words = unitless
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replaceAll(/[_-]+/gu, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .filter((word) => word !== '')
    .map((word) => ACRONYMS[word] ?? word);
  const [first = key, ...rest] = words;
  return [`${first.charAt(0).toUpperCase()}${first.slice(1)}`, ...rest].join(
    ' ',
  );
}

/** How the field shows a unit: its symbol and stored units per shown one. */
export function unitDisplay(
  unit: FieldUnit,
): Readonly<{ symbol: string; scale: number }> {
  switch (unit) {
    case 'milliseconds':
      return { symbol: 's', scale: 1_000 };
    case 'seconds':
      return { symbol: 's', scale: 1 };
    case 'bytes':
      return { symbol: 'bytes', scale: 1 };
  }
}

/** A stored value as the field shows it: 10000 ms → "10". */
export function toShownValue(value: number, unit: FieldUnit | undefined) {
  if (unit === undefined) return value;
  return value / unitDisplay(unit).scale;
}

/** Shown text's number back in stored units, without float noise. */
export function toStoredValue(shown: number, unit: FieldUnit | undefined) {
  if (unit === undefined) return shown;
  return Math.round(shown * unitDisplay(unit).scale * 1_000) / 1_000;
}

/** A stored amount in words with its unit: 30000 ms → "30 s". */
export function describeAmount(value: number, unit: FieldUnit | undefined) {
  if (unit === undefined) return String(value);
  if (unit === 'bytes') return formatByteLength(value);
  if (unit === 'seconds') return secondsInWords(value);
  return `${String(toShownValue(value, unit))} s`;
}

function secondsInWords(seconds: number): string {
  const whole = (size: number, word: string) =>
    `${String(seconds / size)} ${word}${seconds === size ? '' : 's'}`;
  if (seconds >= 86_400 && seconds % 86_400 === 0) return whole(86_400, 'day');
  if (seconds >= 3_600 && seconds % 3_600 === 0) return whole(3_600, 'hour');
  if (seconds >= 60 && seconds % 60 === 0) return whole(60, 'minute');
  return `${String(seconds)} s`;
}
