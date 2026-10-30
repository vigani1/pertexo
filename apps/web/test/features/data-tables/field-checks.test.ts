import {
  readTableValues,
  tableValueErrors,
} from '@/features/data-tables/model/values';
import type { DataTableColumn } from '@pertexo/node-sdk';
import { expect, it } from 'vitest';

const columns =
  /* The value checks read only each column's name, type and requirement. */ [
    { id: 'c1', name: 'amount', type: 'number', required: false },
    { id: 'c2', name: 'count', type: 'number', required: true },
    { id: 'c3', name: 'day', type: 'date', required: false },
    { id: 'c4', name: 'meta', type: 'json', required: false },
    { id: 'c5', name: 'done', type: 'boolean', required: false },
    { id: 'c6', name: 'key', type: 'text', required: true },
  ] as unknown as readonly DataTableColumn[];

const valid = {
  amount: '',
  count: '1',
  day: '',
  meta: '',
  done: '',
  key: 'A-1',
};

function submitRefuses(draft: Record<string, string>): boolean {
  try {
    readTableValues(columns, draft);
    return false;
  } catch {
    return true;
  }
}

const cases = [
  ['amount', '12'],
  ['amount', ' 12 '],
  ['amount', 'heavy'],
  ['count', ''],
  ['count', '7'],
  ['day', '2026-10-19'],
  ['day', '2026-02-30'],
  ['meta', '{"a":1}'],
  ['meta', '{'],
  ['done', 'true'],
  ['done', 'yes'],
  ['key', ' '],
] as const;

// A field shows a problem exactly when sending the row would be refused.
it.each(cases)('agrees with submission on %s = %j', (column, text) => {
  const draft = { ...valid, [column]: text };
  expect(tableValueErrors(columns, draft)[column] !== undefined).toBe(
    submitRefuses(draft),
  );
});

// web-app-12: the field check skips a blank optional value that submit refuses.
it.each(['amount', 'day', 'meta', 'done'] as const)(
  'flags a whitespace-only optional %s before the row is sent',
  (column) => {
    const draft = { ...valid, [column]: '  ' };
    expect(submitRefuses(draft)).toBe(true);
    expect(tableValueErrors(columns, draft)[column]).toBeTypeOf('string');
  },
);
