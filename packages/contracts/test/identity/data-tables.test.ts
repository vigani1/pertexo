import { it, expect } from 'vitest';
import {
  dataTableCreateSchema,
  dataTableLimitsSchema,
  dataTableWriteSchema,
} from '../../src/index.js';
it('bounds typed schemas and admin quota requests without accepting SQL names', () => {
  expect(
    dataTableCreateSchema.safeParse({
      name: 'Orders; drop table',
      columns: [{ name: 'id', type: 'text' }],
    }).success,
  ).toBe(false);
  expect(
    dataTableCreateSchema.safeParse({
      name: 'Orders',
      columns: [
        { name: 'id', type: 'text' },
        { name: 'id', type: 'number' },
      ],
    }).success,
  ).toBe(false);
  const maximum = {
    tableLimit: 100,
    columnLimit: 50,
    rowLimit: 100000,
    byteLimit: 1073741824,
  };
  expect(dataTableLimitsSchema.parse(maximum)).toEqual(maximum);
  expect(
    dataTableLimitsSchema.safeParse({ ...maximum, byteLimit: 1073741825 })
      .success,
  ).toBe(false);
});
it('requires row revisions together and refuses reads on the mutation contract', () => {
  expect(
    dataTableWriteSchema.safeParse({
      command: { operation: 'find', table: 'Orders', query: {} },
    }).success,
  ).toBe(false);
  expect(
    dataTableWriteSchema.safeParse({
      rowId: '10000000-0000-4000-8000-000000000001',
      command: {
        operation: 'update',
        table: 'Orders',
        query: {},
        values: { amount: 1 },
      },
    }).success,
  ).toBe(false);
});
