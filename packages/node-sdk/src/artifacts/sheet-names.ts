import { z } from 'zod';
import { SHEET_NAME_MAX_LENGTH, SHEET_NAME_SUGGESTIONS } from './diagnostic.js';

/** Excel's sheet-name rules, for the sheet a step reads or writes. */
export const sheetNameSchema = z
  .string()
  .min(1)
  .max(SHEET_NAME_MAX_LENGTH)
  .regex(
    // Excel refuses control characters in sheet names too.
    // eslint-disable-next-line no-control-regex
    /^(?!')(?!.*'$)[^\\/?*[\]:\u0000-\u001f\u007f]+$/u,
    'Sheet names cannot use \\ / ? * [ ] or :, or start or end with an apostrophe.',
  );

const LIST_START = 'Its sheets: ';
const UNSAFE = /[\p{Cc}\p{Cf}]/gu;

/**
 * Sheet names are the one piece of file content a failure may show: a test
 * must tell the builder the exact names. Control and bidi characters are
 * dropped, and names and count are bounded so the summary stays small.
 */
export function listSheetNames(
  names: readonly string[],
): Readonly<{ sheets: string[]; more: number }> {
  const usable = names
    .map((name) => Array.from(name.replace(UNSAFE, '')))
    .filter((points) => points.length > 0);
  const sheets = usable
    .slice(0, SHEET_NAME_SUGGESTIONS)
    .map((points) =>
      points.length > SHEET_NAME_MAX_LENGTH
        ? `${points.slice(0, SHEET_NAME_MAX_LENGTH).join('')}…`
        : points.join(''),
    );
  return { sheets, more: Math.min(256, usable.length - sheets.length) };
}

/** JSON string literals keep quotes, commas and full stops in names unambiguous. */
export function describeSheetList(
  listed: Readonly<{ sheets: readonly string[]; more: number }>,
): string {
  if (listed.sheets.length === 0) return 'It has no worksheets.';
  const names = listed.sheets.map((name) => JSON.stringify(name)).join(', ');
  return `${LIST_START}${names}${listed.more > 0 ? ` and ${String(listed.more)} more` : ''}.`;
}

/** Reads back the names a missing-sheet summary lists, for sheet suggestions. */
export function readSheetSuggestions(summary: string): readonly string[] {
  const start = summary.indexOf(LIST_START);
  if (start < 0) return [];
  const names: string[] = [];
  let cursor = start + LIST_START.length;
  for (;;) {
    const end = jsonStringEnd(summary, cursor);
    if (end < 0) break;
    const name = parseJsonString(summary.slice(cursor, end));
    // A shortened name can't match the sheet, so it isn't offered.
    if (name !== undefined && !isShortened(name)) names.push(name);
    if (!summary.startsWith(', ', end)) break;
    cursor = end + 2;
  }
  return names;
}

/** One linear pass to the closing quote; a summary is untrusted text. */
function jsonStringEnd(text: string, from: number): number {
  if (text[from] !== '"') return -1;
  for (let index = from + 1; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (text[index] === '"') return index + 1;
  }
  return -1;
}

function parseJsonString(literal: string): string | undefined {
  try {
    const value: unknown = JSON.parse(literal);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function isShortened(name: string): boolean {
  return Array.from(name).length > SHEET_NAME_MAX_LENGTH && name.endsWith('…');
}
