import { unsupported } from './archive.js';
import type { DateKind } from './styles.js';

/** A cell as typed data and as the text Excel's own CSV export would give. */
export type Cell = Readonly<{ value: string | number | boolean; text: string }>;
export type CellSource = Readonly<{
  type: string | undefined;
  style: number;
  value: string | undefined;
  inline: string | undefined;
}>;
export type CellContext = Readonly<{
  sharedStrings: readonly string[];
  dateStyles: readonly (DateKind | undefined)[];
  date1904: boolean;
}>;

const DOUBLE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u;
const ESCAPED = /_x([0-9A-Fa-f]{4})_/gu;
const DAY = 86_400_000;
// Serial 2,958,465 is 9999-12-31, the last date Excel shows.
const LAST_SERIAL = 2_958_466;

/** Formulas use their cached values; nothing is evaluated. Empty cells give undefined. */
export function decodeCell(
  cell: CellSource,
  context: CellContext,
): Cell | undefined {
  const raw = cell.value ?? '';
  switch (cell.type ?? 'n') {
    case 's':
      // `Number('')` is 0, which would read the first shared string.
      return raw === ''
        ? undefined
        : text(sharedString(raw, context.sharedStrings));
    case 'inlineStr':
      return text(plainText(cell.inline ?? ''));
    case 'str':
      return text(plainText(raw));
    case 'b':
      return raw === '' ? undefined : boolean(raw);
    case 'n':
      return raw === '' ? undefined : number(raw, cell.style, context);
    default:
      // Error values such as #N/A, and ISO dates written as `d`, stay text.
      return text(raw);
  }
}

/** Excel escapes characters XML can't hold as `_xHHHH_`. */
export function plainText(value: string): string {
  return value.replace(ESCAPED, (_, code: string) =>
    String.fromCharCode(Number.parseInt(code, 16)),
  );
}

function sharedString(raw: string, sharedStrings: readonly string[]) {
  const index = Number(raw);
  const value = Number.isInteger(index) ? sharedStrings[index] : undefined;
  return value ?? unsupported();
}

function text(value: string): Cell | undefined {
  return value === '' ? undefined : { value, text: value };
}

function boolean(raw: string): Cell {
  if (raw === '1' || raw === 'true') return { value: true, text: 'TRUE' };
  if (raw === '0' || raw === 'false') return { value: false, text: 'FALSE' };
  return { value: raw, text: raw };
}

function number(raw: string, style: number, context: CellContext): Cell {
  if (!DOUBLE.test(raw)) return { value: raw, text: raw };
  const value = Number(raw);
  const kind = context.dateStyles[style];
  const date =
    kind === undefined ? undefined : isoDate(value, kind, context.date1904);
  if (date !== undefined) return { value: date, text: date };
  // As in CSV, integers beyond the safe range keep their written digits.
  return Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
    ? { value, text: String(value) }
    : { value: raw, text: raw };
}

/**
 * Serials count days from the workbook's epoch. The 1900 system keeps
 * Lotus's phantom 29 February 1900, so serials from 60 shift by a day.
 */
function isoDate(
  serial: number,
  kind: DateKind,
  date1904: boolean,
): string | undefined {
  if (!(serial >= 0 && serial < LAST_SERIAL)) return undefined;
  let days = Math.floor(serial);
  let time = Math.round((serial - days) * DAY);
  if (time === DAY) {
    days++;
    time = 0;
  }
  const epoch = date1904
    ? Date.UTC(1904, 0, 1)
    : Date.UTC(1899, 11, days < 60 ? 31 : 30);
  const iso = new Date(epoch + days * DAY + time).toISOString();
  if (kind === 'date') return iso.slice(0, 10);
  if (kind === 'time') return iso.slice(11, 19);
  return iso;
}
