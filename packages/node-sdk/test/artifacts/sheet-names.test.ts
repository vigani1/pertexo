import { describe, expect, it } from 'vitest';
import { readSheetSuggestions } from '../../src/index.js';
import {
  FileInputFailure,
  describeFileInputFailure,
  listSheetNames,
} from '../../src/server.js';

function summary(names: readonly string[]): string {
  return describeFileInputFailure({
    reason: 'sheet_missing',
    ...listSheetNames(names),
  });
}

describe('missing-sheet summaries', () => {
  it('lists the workbook names so a builder can copy one exactly', () => {
    const names = ['Sales', 'Q2, "final".', 'Notes \\ 2026', '売上'];
    const text = summary(names);
    expect(text).toContain('Its sheets: "Sales", "Q2, \\"final\\".",');
    expect(readSheetSuggestions(text)).toEqual(names);
  });

  it('bounds the list to 20 names and counts the rest', () => {
    const names = Array.from({ length: 256 }, (_, index) => `Sheet${index}`);
    const text = summary(names);
    expect(readSheetSuggestions(text)).toEqual(names.slice(0, 20));
    expect(text).toContain('and 236 more.');
    expect(text.length).toBeLessThan(2048);
  });

  it('drops control and bidi characters and shortens crafted long names', () => {
    const long = 'x'.repeat(40);
    const listed = listSheetNames(['a\u0000b‮c', long, '\u0007']);
    expect(listed.sheets).toEqual(['abc', `${'x'.repeat(31)}…`]);
    expect(
      new FileInputFailure({ reason: 'sheet_missing', ...listed }).diagnostic,
    ).toMatchObject({ reason: 'sheet_missing' });
    // A shortened name can't select the sheet, so it isn't suggested.
    expect(readSheetSuggestions(summary(['abc', long]))).toEqual(['abc']);
  });

  it('says so when the workbook has no worksheets', () => {
    const text = summary([]);
    expect(text).toContain('It has no worksheets.');
    expect(readSheetSuggestions(text)).toEqual([]);
  });

  it('reads nothing from other summaries', () => {
    expect(
      readSheetSuggestions(
        describeFileInputFailure({ reason: 'unsupported_spreadsheet' }),
      ),
    ).toEqual([]);
  });
});
