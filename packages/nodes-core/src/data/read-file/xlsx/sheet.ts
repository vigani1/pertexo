import { FileInputFailure } from '@pertexo/node-sdk/server';
import { tooLarge, unsupported, type WorkbookArchive } from './archive.js';
import { decodeCell, type Cell, type CellContext } from './cells.js';
import { SPREADSHEET_LIMITS } from './limits.js';
import { readXml, readXmlPart } from './xml.js';

/** One sheet row: cells with a value, by 1-based column. */
export type SheetRow = Readonly<{ index: number; cells: Map<number, Cell> }>;
export type MergedArea = Readonly<{
  top: number;
  left: number;
  bottom: number;
  right: number;
}>;

interface OpenCell {
  column: number;
  type: string | undefined;
  style: number;
  value: string | undefined;
  inline: string | undefined;
}
const REFERENCE = /^([A-Z]{1,3})([1-9]\d{0,6})$/u;

/**
 * Streams the rows of one worksheet. `countCell` sees every cell element,
 * empty ones included, so the per-step cell budget holds for hostile sheets.
 */
export async function* readSheetRows(
  sheet: Readonly<{
    archive: WorkbookArchive;
    part: string;
    context: CellContext;
    countCell: () => void;
  }>,
  signal: AbortSignal,
): AsyncGenerator<SheetRow> {
  const { archive, part, context, countCell } = sheet;
  const finished: SheetRow[] = [];
  let row: SheetRow | undefined,
    cell: OpenCell | undefined,
    target: 'value' | 'inline' | undefined,
    phonetic = 0,
    lastRow = 0,
    lastColumn = 0;
  const append = (text: string) => {
    if (cell === undefined || target === undefined) return;
    const next = (cell[target] ?? '') + text;
    if (next.length > SPREADSHEET_LIMITS.cellTextLength)
      throw new FileInputFailure({ reason: 'value_size' });
    cell[target] = next;
  };
  const visitor = {
    open: (
      name: string,
      attributes: Readonly<Record<string, string | undefined>>,
    ) => {
      if (name === 'row') {
        lastRow = position(
          attributes.r === undefined ? undefined : Number(attributes.r),
          lastRow,
          SPREADSHEET_LIMITS.rows,
        );
        row = { index: lastRow, cells: new Map() };
        lastColumn = 0;
      } else if (name === 'c' && row !== undefined) {
        countCell();
        lastColumn = position(
          attributes.r === undefined ? undefined : cellAt(attributes.r).column,
          lastColumn,
          SPREADSHEET_LIMITS.columns,
        );
        cell = {
          column: lastColumn,
          type: attributes.t,
          style: Number(attributes.s ?? 0),
          value: undefined,
          inline: undefined,
        };
      } else if (cell !== undefined) {
        if (name === 'rPh') phonetic++;
        else if (name === 'v') target = 'value';
        else if (name === 't' && phonetic === 0) target = 'inline';
      }
    },
    text: append,
    close: (name: string) => {
      if (name === 'v' || name === 't') target = undefined;
      else if (name === 'rPh') phonetic--;
      else if (name === 'c' && cell !== undefined && row !== undefined) {
        const decoded = decodeCell(cell, context);
        if (decoded !== undefined) row.cells.set(cell.column, decoded);
        cell = undefined;
      } else if (name === 'row' && row !== undefined) {
        finished.push(row);
        row = undefined;
      }
    },
  };
  for await (const _ of readXmlPart(
    archive.read(part, signal),
    visitor,
    signal,
  ))
    yield* finished.splice(0);
}

/** Excel writes merged areas after the cells, so they need a pass of their own. */
export async function readMergedAreas(
  archive: WorkbookArchive,
  part: string,
  signal: AbortSignal,
): Promise<readonly MergedArea[]> {
  const areas: MergedArea[] = [];
  await readXml(
    archive.read(part, signal),
    {
      open: (name, attributes) => {
        if (name !== 'mergeCell' || attributes.ref === undefined) return;
        if (areas.length >= SPREADSHEET_LIMITS.merges) tooLarge();
        const [start, end] = attributes.ref.split(':');
        const top = cellAt(start);
        const bottom = cellAt(end ?? start);
        if (bottom.row < top.row || bottom.column < top.column) unsupported();
        areas.push({
          top: top.row,
          left: top.column,
          bottom: bottom.row,
          right: bottom.column,
        });
      },
    },
    signal,
  );
  return areas;
}

/** Rows and cells may omit their position; written ones must ascend. */
function position(
  written: number | undefined,
  previous: number,
  maximum: number,
): number {
  const next = written ?? previous + 1;
  if (!Number.isInteger(next) || next <= previous || next > maximum)
    unsupported();
  return next;
}

function cellAt(reference: string | undefined) {
  const match = REFERENCE.exec(reference?.toUpperCase() ?? '');
  if (match === null) return unsupported();
  let column = 0;
  for (const letter of match[1] ?? '')
    column = column * 26 + letter.charCodeAt(0) - 64;
  return { column, row: Number(match[2]) };
}
