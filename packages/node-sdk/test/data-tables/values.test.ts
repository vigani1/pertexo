import { describe, it, expect } from 'vitest';
import {
  dataTableNewColumnsSchema,
  dataTableValuesSchema,
  dataTableCommandSchema,
  validateDataTableValues,
  validateDataTableQuery,
  dataTableCsvValue,
  escapeDataTableCsv,
  DataTableError,
} from '../../src/index.js';
const columns = dataTableNewColumnsSchema.parse([
  { name: 'id', type: 'text', required: true },
  { name: 'amount', type: 'number' },
  { name: 'active', type: 'boolean' },
  { name: 'day', type: 'date' },
  { name: 'meta', type: 'json' },
]);
describe('typed data table boundary', () => {
  it('keeps typed false and zero, fills optional cells and rejects unknown columns', () => {
    expect(
      validateDataTableValues(columns, {
        id: '00123',
        amount: 0,
        active: false,
      }),
    ).toEqual({ id: '00123', amount: 0, active: false, day: null, meta: null });
    expect(() =>
      validateDataTableValues(columns, { id: 'x', extra: 1 }),
    ).toThrow(DataTableError);
    expect(() =>
      validateDataTableValues(columns, { id: 'x', amount: '2' }),
    ).toThrow('needs number');
  });
  it('validates calendar dates, Unicode, finite numbers and bounded rows', () => {
    expect(() =>
      validateDataTableValues(columns, { id: 'x', day: '2026-02-30' }),
    ).toThrow('needs date');
    expect(() =>
      validateDataTableValues(columns, { id: 'x', meta: { nested: '\u0000' } }),
    ).toThrow('UTF-8');
    expect(() =>
      validateDataTableValues(columns, { id: 'x', meta: 'x'.repeat(65536) }),
    ).toThrow('64 KiB');
    expect(() =>
      validateDataTableValues(columns, { id: 'x', amount: Infinity }),
    ).toThrow();
  });
  it('validates partial updates without clearing other required cells', () => {
    expect(validateDataTableValues(columns, { amount: 3 }, true)).toEqual({
      amount: 3,
    });
    expect(() => validateDataTableValues(columns, { id: null }, true)).toThrow(
      'required',
    );
  });
  it('converts CSV by the declared column type and escapes formulas for export', () => {
    expect(dataTableCsvValue(required(columns[0]), '00123')).toBe('00123');
    expect(dataTableCsvValue(required(columns[1]), '12.5')).toBe(12.5);
    expect(dataTableCsvValue(required(columns[2]), 'false')).toBe(false);
    expect(dataTableCsvValue(required(columns[4]), '{"x":1}')).toEqual({
      x: 1,
    });
    expect(escapeDataTableCsv('=SUM(A1)')).toBe('"\'=SUM(A1)"');
    expect(escapeDataTableCsv('a,"b"')).toBe('"a,""b"""');
  });
  it('bounds query shapes and validates filter columns and types', () => {
    expect(() =>
      dataTableCommandSchema.parse({
        operation: 'find',
        table: 'Orders',
        query: { limit: 1001 },
      }),
    ).toThrow();
    expect(() => {
      validateDataTableQuery(columns, {
        filters: [{ column: 'amount', operator: 'contains', value: 1 }],
        offset: 0,
        limit: 10,
      });
    }).toThrow('text');
    expect(() => {
      validateDataTableQuery(columns, {
        filters: [{ column: 'missing', operator: 'equals', value: 1 }],
        offset: 0,
        limit: 10,
      });
    }).toThrow('Unknown');
    expect(() =>
      dataTableNewColumnsSchema.parse([
        { name: 'x', type: 'text' },
        { name: 'x', type: 'number' },
      ]),
    ).toThrow('unique');
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Fixture value missing');
  return value;
}

it('rejects adversarial depth and cycles before recursive JSON parsing', () => {
  let value: unknown = 0;
  for (let depth = 0; depth < 10000; depth++) value = { next: value };
  expect(dataTableValuesSchema.safeParse({ meta: value }).success).toBe(false);
  const cyclic: Record<string, unknown> = {};
  cyclic.next = cyclic;
  expect(dataTableValuesSchema.safeParse(cyclic).success).toBe(false);
});
