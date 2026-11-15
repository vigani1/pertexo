/** Excel column letters: A to Z, then AA; the writer and the reader share them. */
export const EXCEL_COLUMN_LETTERS = Object.freeze({
  count: 26,
  // 'A' is code 65, so a letter's column number is its code minus 64.
  codeBeforeA: 64,
});

/**
 * Excel's `_xHHHH_` escape for a character XML can't hold: four hex digits,
 * seven written characters in all.
 */
export const EXCEL_ESCAPE = Object.freeze({
  radix: 16,
  digits: 4,
  writtenCharacters: 7,
});

/** Excel's own sheet size; the reader and the writer both hold to it. */
export const EXCEL_SHEET_LIMITS = Object.freeze({
  rows: 1_048_576,
  columns: 16_384,
  /** Characters in one cell, counted after `_xHHHH_` unescaping. */
  cellTextLength: 32_767,
});
