import { looksLikeFormula } from '@pertexo/node-sdk';
import type { JsonValue } from '@pertexo/node-sdk/server';
import { refuseFileCreation } from '../failure.js';

export type SheetRow = Readonly<Record<string, JsonValue>>;

/**
 * Style indexes in the workbook's styles part; header and quoted add up to
 * the bold quoted style. quotePrefix keeps formula-like text as text even
 * after someone edits the cell in Excel.
 */
const SHEET_STYLES = Object.freeze({ header: 1, quoted: 2 });

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const CELL_TEXT_LENGTH = 32_767;
const CHUNK = 65_536;
// XML can't hold these; Excel writes them, and carriage returns, as _xHHHH_.
// eslint-disable-next-line no-control-regex
const UNWRITABLE = /[\u0000-\u0008\u000b\u000c\u000d\u000e-\u001f￾￿]/gu;

/**
 * Streams one worksheet: a bold header row frozen above typed cells. Values
 * are written as numbers, booleans or text and never as formulas; objects
 * and lists become compact JSON, and missing or null cells stay empty.
 */
export async function* sheetXml(
  columns: readonly string[],
  rows: AsyncIterable<SheetRow> | Iterable<SheetRow>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const letters = columns.map((_, index) => columnLetters(index));
  let pending = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<worksheet xmlns="${MAIN}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>`;
  pending += `<row r="1">${columns.map((name, index) => textCell(`${letters[index] ?? ''}1`, name, true)).join('')}</row>`;
  let index = 1;
  for await (const row of rows) {
    signal.throwIfAborted();
    index++;
    const cells = columns.map((name, column) =>
      cell(
        `${letters[column] ?? ''}${String(index)}`,
        Object.hasOwn(row, name) ? row[name] : null,
        index,
      ),
    );
    pending += `<row r="${String(index)}">${cells.join('')}</row>`;
    if (pending.length >= CHUNK) {
      yield Buffer.from(pending, 'utf8');
      pending = '';
    }
  }
  yield Buffer.from(`${pending}</sheetData></worksheet>`, 'utf8');
}

export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function cell(reference: string, value: JsonValue | undefined, row: number) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number')
    return `<c r="${reference}"><v>${String(value)}</v></c>`;
  if (typeof value === 'boolean')
    return `<c r="${reference}" t="b"><v>${value ? '1' : '0'}</v></c>`;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length > CELL_TEXT_LENGTH)
    refuseFileCreation(
      'data',
      `Excel cells hold up to 32,767 characters; row ${String(row)} has a longer value. Shorten it, or choose CSV or JSON.`,
    );
  return textCell(reference, text, false);
}

function textCell(reference: string, text: string, header: boolean): string {
  const style =
    (header ? SHEET_STYLES.header : 0) +
    (looksLikeFormula(text) ? SHEET_STYLES.quoted : 0);
  return `<c r="${reference}" t="inlineStr"${style === 0 ? '' : ` s="${String(style)}"`}><is><t xml:space="preserve">${escapeXml(excelText(text))}</t></is></c>`;
}

/** Excel's `_xHHHH_` escapes; a literal escape-like run protects its underscore. */
function excelText(text: string): string {
  return text
    .toWellFormed()
    .replace(/_(x[0-9A-Fa-f]{4}_)/gu, '_x005F_$1')
    .replace(
      UNWRITABLE,
      (character) =>
        `_x${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`,
    );
}

/** 0 → A, 25 → Z, 26 → AA. */
function columnLetters(index: number): string {
  let letters = '';
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26))
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  return letters;
}
