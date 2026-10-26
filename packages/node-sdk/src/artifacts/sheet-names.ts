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
const QUOTED = /"(?:[^"\\]|\\.)*"/uy;

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
  QUOTED.lastIndex = start + LIST_START.length;
  for (;;) {
    const match = QUOTED.exec(summary);
    if (match === null) break;
    const name: unknown = JSON.parse(match[0]);
    // A shortened name can't match the sheet, so it isn't offered.
    if (typeof name === 'string' && !isShortened(name)) names.push(name);
    if (!summary.startsWith(', ', QUOTED.lastIndex)) break;
    QUOTED.lastIndex += 2;
  }
  return names;
}

function isShortened(name: string): boolean {
  return Array.from(name).length > SHEET_NAME_MAX_LENGTH && name.endsWith('…');
}
