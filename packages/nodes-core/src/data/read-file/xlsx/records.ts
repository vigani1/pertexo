import { FileInputFailure, type JsonValue } from '@pertexo/node-sdk/server';
import { admitHeaders } from '../headers.js';
import type { CoreReadFileConfig } from '../validation.js';
import { tooLarge } from './archive.js';
import type { Cell } from './cells.js';
import { SPREADSHEET_LIMITS } from './limits.js';
import { readSharedStrings } from './shared-strings.js';
import {
  readMergedAreas,
  readSheetRows,
  type MergedArea,
  type SheetRow,
} from './sheet.js';
import { readDateStyles } from './styles.js';
import { chooseSheet, openWorkbook } from './workbook.js';

type XlsxConfig = Extract<CoreReadFileConfig, { format: 'xlsx' }>;
type Row = Readonly<Record<string, JsonValue>>;

/**
 * Produces the same row objects as CSV: one per row below the header row,
 * keyed by its names, with empty cells as empty text. Empty rows and
 * trailing columns are dropped; only the one sheet is read.
 */
export async function* readXlsxRecords<T>(
  bytes: Uint8Array,
  config: XlsxConfig,
  signal: AbortSignal,
  options: Readonly<{ accept(row: Row): T }>,
): AsyncGenerator<T> {
  const workbook = await openWorkbook(bytes, signal);
  const sheet = chooseSheet(workbook, config.sheet);
  const context = {
    sharedStrings: await readSharedStrings(
      workbook.archive,
      workbook.sharedStringsPart,
      signal,
    ),
    dateStyles: await readDateStyles(
      workbook.archive,
      workbook.stylesPart,
      signal,
    ),
    date1904: workbook.date1904,
  };
  let cells = 0;
  const countCell = () => {
    if (++cells > SPREADSHEET_LIMITS.cells) tooLarge();
  };
  const merges = mergedFill(
    await readMergedAreas(workbook.archive, sheet.part, signal),
    countCell,
  );
  let headers: readonly string[] | undefined;
  const rows = readSheetRows(
    { archive: workbook.archive, part: sheet.part, context, countCell },
    signal,
  );
  for await (const row of rows) {
    merges.capture(row);
    if (row.index < config.headerRow || row.cells.size === 0) continue;
    if (headers !== undefined) {
      yield options.accept(dataRow(row, headers, merges, config.convertValues));
      continue;
    }
    if (row.index > config.headerRow) break;
    const own = new Set(row.cells.keys());
    merges.fill(row);
    headers = headerNames(row, own);
    merges.narrow(headers.length);
  }
  if (headers === undefined)
    throw new FileInputFailure({
      reason: 'sheet_header_row',
      row: config.headerRow,
    });
}

/** Cells under no header fail like CSV's extra columns; empty styled cells never reach here. */
function dataRow(
  row: SheetRow,
  headers: readonly string[],
  merges: ReturnType<typeof mergedFill>,
  convertValues: boolean,
): Row {
  const outside = [...row.cells.keys()].find(
    (column) => column > headers.length,
  );
  if (outside !== undefined)
    throw new FileInputFailure({ reason: 'blank_header', column: outside });
  merges.fill(row, headers.length);
  return Object.fromEntries(
    headers.map((name, index) => {
      const cell = row.cells.get(index + 1);
      if (cell === undefined) return [name, ''];
      return [name, convertValues ? cell.value : cell.text];
    }),
  );
}

/**
 * Header names are the cells' text, up to the last named column. A repeat
 * that a merged area filled in says so: the merge rule, not the person's
 * names, made it.
 */
function headerNames(
  row: SheetRow,
  own: ReadonlySet<number>,
): readonly string[] {
  const width = Math.max(...row.cells.keys());
  const names = Array.from(
    { length: width },
    (_, index) => row.cells.get(index + 1)?.text ?? '',
  );
  try {
    return admitHeaders(names);
  } catch (error) {
    if (
      error instanceof FileInputFailure &&
      error.diagnostic.reason === 'duplicate_header' &&
      !own.has(error.diagnostic.column)
    )
      throw new FileInputFailure({ ...error.diagnostic, merged: true });
    throw error;
  }
}

/**
 * Every position of a merged area reads its top-left value. Fills count
 * toward the cell budget, and areas outside the header are dropped once its
 * width is known, so a hostile merge can't multiply the work.
 */
function mergedFill(areas: readonly MergedArea[], countCell: () => void) {
  let pending = [...areas].sort((left, right) => left.top - right.top);
  let active: (MergedArea & { value?: Cell | undefined })[] = [];
  let next = 0;
  return {
    capture(row: SheetRow) {
      for (
        let area = pending[next];
        area !== undefined && area.top <= row.index;
        area = pending[++next]
      )
        active.push({ ...area });
      active = active.filter((area) => area.bottom >= row.index);
      for (const area of active)
        if (area.top === row.index) area.value = row.cells.get(area.left);
    },
    fill(row: SheetRow, width: number = SPREADSHEET_LIMITS.columns) {
      for (const area of active) {
        if (area.value === undefined) continue;
        for (
          let column = area.left;
          column <= Math.min(area.right, width);
          column++
        )
          if (row.index !== area.top || column !== area.left) {
            countCell();
            row.cells.set(column, area.value);
          }
      }
    },
    narrow(width: number) {
      active = active.filter((area) => area.left <= width);
      pending = pending.slice(next).filter((area) => area.left <= width);
      next = 0;
    },
  };
}
