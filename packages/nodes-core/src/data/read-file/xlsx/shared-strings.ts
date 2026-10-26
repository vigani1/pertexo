import { FileInputFailure } from '@pertexo/node-sdk/server';
import { tooLarge, type WorkbookArchive } from './archive.js';
import { plainText } from './cells.js';
import { SPREADSHEET_LIMITS } from './limits.js';
import { readXml } from './xml.js';

/** Rich text becomes plain text; phonetic guides (`rPh`) are left out. */
export async function readSharedStrings(
  archive: WorkbookArchive,
  part: string | undefined,
  signal: AbortSignal,
): Promise<readonly string[]> {
  if (part === undefined) return [];
  const strings: string[] = [];
  let item: string | undefined,
    phonetic = 0,
    inText = false,
    length = 0;
  await readXml(
    archive.read(part, signal),
    {
      open: (name) => {
        if (name === 'si') item = '';
        else if (name === 'rPh') phonetic++;
        else if (name === 't') inText = item !== undefined && phonetic === 0;
      },
      text: (text) => {
        if (!inText || item === undefined) return;
        item += text;
        length += text.length;
        if (item.length > SPREADSHEET_LIMITS.cellTextLength)
          throw new FileInputFailure({ reason: 'value_size' });
        if (length > SPREADSHEET_LIMITS.sharedTextLength) tooLarge();
      },
      close: (name) => {
        if (name === 't') inText = false;
        else if (name === 'rPh') phonetic--;
        else if (name === 'si' && item !== undefined) {
          if (strings.length >= SPREADSHEET_LIMITS.sharedStrings) tooLarge();
          strings.push(plainText(item));
          item = undefined;
        }
      },
    },
    signal,
  );
  return strings;
}
