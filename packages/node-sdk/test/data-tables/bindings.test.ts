import { expect, it } from 'vitest';
import {
  bindDataTableCommand,
  projectBoundDataTableResult,
  resolveDataTableBindings,
  dataTableColumnsSchema,
  dataTableBindingsSchema,
} from '../../src/index.js';

const columns = dataTableColumnsSchema.parse([
  { id: 'key', name: 'order_key', type: 'text', required: true },
  { id: 'amount', name: 'total', type: 'number', required: false },
]);

it('keeps original workflow aliases across column renames for values, filters, sort and output paths', () => {
  const names = resolveDataTableBindings(
    columns,
    { key: 'key', amount: 'amount' },
    false,
  );
  expect(
    bindDataTableCommand(
      {
        operation: 'update',
        table: 'Orders',
        values: { amount: 2 },
        query: {
          filters: [{ column: 'key', operator: 'equals', value: 'a' }],
          sort: { column: 'amount', direction: 'desc' },
          limit: 10,
          offset: 0,
        },
      },
      names,
    ),
  ).toEqual({
    operation: 'update',
    table: 'Orders',
    values: { total: 2 },
    query: {
      filters: [{ column: 'order_key', operator: 'equals', value: 'a' }],
      sort: { column: 'total', direction: 'desc' },
      limit: 10,
      offset: 0,
    },
  });
  expect(
    projectBoundDataTableResult(
      {
        rows: [
          {
            id: '10000000-0000-4000-8000-000000000001',
            revision: 2,
            values: { order_key: 'a', total: 2, unbound: 'hidden' },
          },
        ],
        affected: 1,
        hasMore: false,
      },
      names,
    ).rows[0]?.values,
  ).toEqual({ key: 'a', amount: 2 });
  expect(resolveDataTableBindings(columns, undefined, false)).toEqual(names);
});

it('refuses removed bindings and unverifiable legacy steps without retargeting a recreated name', () => {
  expect(() =>
    resolveDataTableBindings(
      [
        {
          ...columns[0],
          id: 'new_key',
          name: 'key',
          type: 'text',
          required: true,
        },
      ],
      { key: 'key' },
      true,
    ),
  ).toThrow('removed');
  expect(() => resolveDataTableBindings(columns, undefined, true)).toThrow(
    'legacy',
  );
  const names = resolveDataTableBindings(columns, { key: 'key' }, true);
  expect(() =>
    bindDataTableCommand(
      { operation: 'insert', table: 'Orders', values: { amount: 2 } },
      names,
    ),
  ).toThrow('not bound');
});

it('requires unambiguous stored IDs and bindings at their boundaries', () => {
  expect(
    dataTableColumnsSchema.safeParse([
      { id: 'a', name: 'first', type: 'text' },
      { id: 'a', name: 'second', type: 'text' },
    ]).success,
  ).toBe(false);
  expect(
    dataTableBindingsSchema.safeParse({ first: 'same', second: 'same' })
      .success,
  ).toBe(false);
});
