/** Excel column letters: A to Z, then AA; the writer and the reader share them. */
export const EXCEL_COLUMN_LETTERS = Object.freeze({
  count: 26,
  // 'A' is code 65, so a letter's column number is its code minus 64.
  codeBeforeA: 64,
});

/** Excel's `_xHHHH_` escape for a character XML can't hold: four hex digits. */
export const EXCEL_ESCAPE = Object.freeze({ radix: 16, digits: 4 });
