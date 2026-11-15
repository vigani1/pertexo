import { EXCEL_ESCAPE, EXCEL_SHEET_LIMITS } from '../../excel-format.js';

/**
 * Hostile workbooks are refused from the zip directory before inflating, and
 * the same bounds hold for the bytes actually inflated. Sizes use the guide's
 * binary units: 100 MB is 100 MiB.
 */
export const SPREADSHEET_LIMITS = Object.freeze({
  entries: 1_000,
  uncompressedBytes: 104_857_600,
  sheets: 256,
  cells: 1_000_000,
  merges: 100_000,
  styles: 65_536,
  sharedStrings: 1_000_000,
  sharedTextLength: 33_554_432,
  /** A cell's written text if every character were escaped. */
  writtenCellTextLength:
    EXCEL_SHEET_LIMITS.cellTextLength * EXCEL_ESCAPE.writtenCharacters,
  xmlDepth: 64,
  xmlAttributes: 128,
  /** The XML parser buffers an unfinished tag, attribute or comment whole. */
  xmlPendingLength: 1_048_576,
});
