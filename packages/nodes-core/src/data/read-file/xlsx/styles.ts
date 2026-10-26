import { tooLarge, type WorkbookArchive } from './archive.js';
import { SPREADSHEET_LIMITS } from './limits.js';
import { readXml } from './xml.js';

export type DateKind = 'date' | 'time' | 'datetime';

// Excel's built-in number formats that show dates or times; 27–36 and 50–58
// are the East Asian date formats. 46 ([h]:mm:ss) is elapsed time, a number.
const BUILT_IN = new Map<number, DateKind>([
  ...[14, 15, 16, 17, 27, 28, 29, 30, 31, 34, 35, 36].map(
    (id) => [id, 'date'] as const,
  ),
  ...[50, 51, 52, 53, 54, 55, 56, 57, 58].map((id) => [id, 'date'] as const),
  ...[18, 19, 20, 21, 32, 33, 45, 47].map((id) => [id, 'time'] as const),
  [22, 'datetime'],
]);

/** Only the number format matters: a numeric cell styled as a date reads as one. */
export async function readDateStyles(
  archive: WorkbookArchive,
  part: string | undefined,
  signal: AbortSignal,
): Promise<readonly (DateKind | undefined)[]> {
  if (part === undefined) return [];
  const formats = new Map<number, DateKind | undefined>();
  const styles: number[] = [];
  let inCellFormats = false;
  await readXml(
    archive.read(part, signal),
    {
      open: (name, attributes) => {
        if (name === 'cellXfs') inCellFormats = true;
        if (name === 'numFmt' && attributes.numFmtId !== undefined) {
          if (formats.size >= SPREADSHEET_LIMITS.styles) tooLarge();
          formats.set(
            Number(attributes.numFmtId),
            classifyFormat(attributes.formatCode ?? ''),
          );
        }
        if (name === 'xf' && inCellFormats) {
          if (styles.length >= SPREADSHEET_LIMITS.styles) tooLarge();
          styles.push(Number(attributes.numFmtId ?? 0));
        }
      },
      close: (name) => {
        if (name === 'cellXfs') inCellFormats = false;
      },
    },
    signal,
  );
  return styles.map((id) =>
    formats.has(id) ? formats.get(id) : BUILT_IN.get(id),
  );
}

/**
 * Reads the first section of a custom format, ignoring quoted text, escapes,
 * colours and locales. `m` means minutes beside hours or seconds.
 */
function classifyFormat(code: string): DateKind | undefined {
  const bare = code.replace(/"[^"]*"|\\.|_.|\*./gu, '').split(';')[0] ?? '';
  if (/\[(?:h+|m+|s+)\]/iu.test(bare)) return undefined;
  const tokens = bare.replace(/\[[^\]]*\]/gu, '');
  const time = /[hs]|AM\/PM|A\/P/iu.test(tokens);
  const date = /[dy]/iu.test(tokens) || (/m/iu.test(tokens) && !time);
  if (date && time) return 'datetime';
  if (date) return 'date';
  return time ? 'time' : undefined;
}
