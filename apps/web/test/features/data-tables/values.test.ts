import {
  tableCellText,
  tableValueErrors,
} from '@/features/data-tables/model/values';
import type { DataTableColumn } from '@pertexo/node-sdk';
import { expect, it } from 'vitest';

const columns =
  /* This focused fixture supplies the table fields read by the value editor; unrelated metadata is omitted. */ [
    { id: 'c1', name: 'key', type: 'text', required: true },
    { id: 'c2', name: 'amount', type: 'number', required: false },
    { id: 'c3', name: 'day', type: 'date', required: false },
    { id: 'c4', name: 'meta', type: 'json', required: false },
  ] as unknown as readonly DataTableColumn[];

it('says what is wrong with each field before the row is sent', () => {
  expect(
    tableValueErrors(columns, {
      key: ' ',
      amount: 'heavy',
      day: '2026-02-30',
      meta: '{',
    }),
  ).toEqual({
    key: 'Enter a value.',
    amount: 'Enter a number.',
    day: 'Use a date like 2026-10-19.',
    meta: 'Enter valid JSON.',
  });
  expect(
    tableValueErrors(columns, {
      key: 'A-1',
      amount: '10.5',
      day: '2026-10-19',
      meta: '{"a":1}',
    }),
  ).toEqual({
    key: undefined,
    amount: undefined,
    day: undefined,
    meta: undefined,
  });
  expect(tableValueErrors(columns, { key: 'A-1', day: '2026-13-01' }).day).toBe(
    'Use a date like 2026-10-19.',
  );
});

it('shows cells as people wrote them, with empty cells as empty', () => {
  expect(tableCellText(null)).toBeUndefined();
  expect(tableCellText('first “quoted”\nsecond line')).toBe(
    'first “quoted”\nsecond line',
  );
  expect(tableCellText(true)).toBe('Yes');
  expect(tableCellText(10.5)).toBe('10.5');
  expect(tableCellText({ a: [1, 2] })).toBe('{"a":[1,2]}');
});
