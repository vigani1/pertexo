/**
 * Hostile workbooks are refused from the zip directory before inflating, and
 * the same bounds hold for the bytes actually inflated. Sizes use the guide's
 * binary units: 100 MB is 100 MiB.
 */
const EXCEL_CELL_TEXT_LENGTH = 32_767;

export const SPREADSHEET_LIMITS = Object.freeze({
  entries: 1_000,
  uncompressedBytes: 104_857_600,
  sheets: 256,
  cells: 1_000_000,
  merges: 100_000,
  styles: 65_536,
  sharedStrings: 1_000_000,
  sharedTextLength: 33_554_432,
  /** Excel's own cell limit, counted after `_xHHHH_` unescaping. */
  cellTextLength: EXCEL_CELL_TEXT_LENGTH,
  /** Each escape is seven written characters for one read. */
  writtenCellTextLength: EXCEL_CELL_TEXT_LENGTH * 7,
  rows: 1_048_576,
  columns: 16_384,
  xmlDepth: 64,
  xmlAttributes: 128,
  /** The XML parser buffers an unfinished tag, attribute or comment whole. */
  xmlPendingLength: 1_048_576,
});
