import { describe, expect, it } from 'vitest';
import {
  changeDataTableDefinition,
  changeDataTableValues,
} from '../../src/data-tables/schema.js';
import type { DataTableColumn } from '../../src/data-tables/contract.js';

const columns: DataTableColumn[] = [
  { id: 'key', name: 'Key', type: 'text', required: true },
  { id: 'value', name: 'Value', type: 'number', required: false },
];
const table = {
  columns,
  keyColumn: 'Key',
  hasRemovedColumns: false,
  revision: 1,
};
describe('data-table schema changes', () => {
  it('renames a unique key by stable identity without mutating its source', () => {
    const change = {
      operation: 'rename_column',
      columnId: 'key',
      name: 'Renamed',
    } as const;
    const next = changeDataTableDefinition(table, change, 'unused');
    expect(next).toMatchObject({
      keyColumn: 'Renamed',
      revision: 2,
      columns: [{ id: 'key', name: 'Renamed' }, { id: 'value' }],
    });
    expect(table.columns[0]?.name).toBe('Key');
    expect(
      changeDataTableValues(columns, next, change, { Key: 'first', Value: 3 }),
    ).toEqual({ Renamed: 'first', Value: 3 });
  });
  it('adds the supplied stable ID and fills the default value', () => {
    const change = {
      operation: 'add_column',
      column: { name: 'Added', type: 'text', required: true },
      defaultValue: 'new',
    } as const;
    const next = changeDataTableDefinition(table, change, 'new_id');
    expect(next.columns.at(-1)).toMatchObject({ id: 'new_id', name: 'Added' });
    expect(
      changeDataTableValues(columns, next, change, { Key: 'first' }),
    ).toEqual({ Key: 'first', Value: null, Added: 'new' });
  });
  it('removes a key column and records the removal', () => {
    expect(
      changeDataTableDefinition(
        table,
        { operation: 'remove_column', columnId: 'key', confirm: true },
        'unused',
      ),
    ).toMatchObject({
      keyColumn: null,
      hasRemovedColumns: true,
      columns: [{ id: 'value' }],
    });
  });
  it('rejects duplicate names and stale column identities', () => {
    expect(() =>
      changeDataTableDefinition(
        table,
        { operation: 'rename_column', columnId: 'value', name: 'Key' },
        'unused',
      ),
    ).toThrow('already uses');
    expect(() =>
      changeDataTableDefinition(
        table,
        { operation: 'remove_column', columnId: 'missing', confirm: true },
        'unused',
      ),
    ).toThrow('removed');
  });
  it('refuses removal of the last column and invalid unique keys', () => {
    expect(() =>
      changeDataTableDefinition(
        { ...table, columns: columns.slice(0, 1) },
        { operation: 'remove_column', columnId: 'key', confirm: true },
        'unused',
      ),
    ).toThrow('at least one');
    expect(() =>
      changeDataTableDefinition(
        table,
        { operation: 'set_key', columnId: 'value' },
        'unused',
      ),
    ).toThrow('required text');
  });
  it('clears a unique key explicitly', () => {
    expect(
      changeDataTableDefinition(
        table,
        { operation: 'set_key', columnId: null },
        'unused',
      ).keyColumn,
    ).toBeNull();
  });
});
