import { expect, it } from 'vitest';
import {
  readVariableRows,
  variableRows,
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
