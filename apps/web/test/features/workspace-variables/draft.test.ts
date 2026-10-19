import { expect, it } from 'vitest';
import {
  readVariableRows,
  valuePreview,
  variableMatches,
  variableRows,
  variableUnsaved,
} from '@/features/workspace-variables/model/draft';
it('keeps false, zero, empty text and multiline text with explicit types', () => {
  const values = { ZERO: 0, OFF: false, EMPTY: '', NOTE: 'Line 1\nLine 2' };
  expect(readVariableRows(variableRows(values))).toEqual({
    values,
    descriptions: {},
  });
});
it('refuses duplicate names, invalid names and blank/nonfinite numbers before serialization', () => {
  const row = {
    id: 'a',
    name: 'RATE',
    type: 'number' as const,
    value: '0',
    description: '',
  };
  expect(readVariableRows([row, { ...row, id: 'b' }]).error).toContain(
    'more than once',
  );
  expect(readVariableRows([{ ...row, name: 'lowercase' }]).error).toContain(
    'uppercase',
  );
  for (const value of ['', 'Infinity', 'NaN'])
    expect(readVariableRows([{ ...row, value }]).error).toContain('finite');
});
it('keeps descriptions optional, trims metadata and leaves text values unchanged', () => {
  const rows = variableRows(
    { NOTE: '  raw text  ', RATE: 0 },
    { NOTE: '  Usage note  ', RATE: '   ' },
  );
  expect(readVariableRows(rows)).toEqual({
    values: { NOTE: '  raw text  ', RATE: 0 },
    descriptions: { NOTE: 'Usage note' },
  });
  expect(
    readVariableRows(variableRows({ NOTE: 'raw' }, { NOTE: 'a'.repeat(501) })),
  ).toHaveProperty('error');
});
it('previews values on one line and knows which rows differ from the saved set', () => {
  const [note, flag] = variableRows(
    { NOTE: 'Line 1\nLine 2', FLAG: false },
    { NOTE: 'Shown in emails' },
  );
  if (note === undefined || flag === undefined) throw new Error('rows missing');
  expect(valuePreview(note)).toBe('Line 1 ⏎ Line 2');
  expect(valuePreview(flag)).toBe('False');
  expect(valuePreview({ ...note, value: '' })).toBe('Empty');
  expect(variableMatches(note, '  emails ')).toBe(true);
  expect(variableMatches(flag, 'note')).toBe(false);
  const saved = {
    values: { NOTE: 'Line 1\nLine 2', FLAG: false },
    descriptions: { NOTE: 'Shown in emails' },
  };
  expect(variableUnsaved(note, saved)).toBe(false);
  expect(variableUnsaved({ ...note, description: '' }, saved)).toBe(true);
  expect(variableUnsaved({ ...flag, value: 'true' }, saved)).toBe(true);
  expect(variableUnsaved({ ...flag, name: 'NEW_FLAG' }, saved)).toBe(true);
});
