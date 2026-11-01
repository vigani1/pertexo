import {
  DataTableError,
  isDataTableKeyColumn,
  type DataTableColumn,
  type DataTableSchemaChange,
  type DataTableValues,
} from './contract.js';
import { validateDataTableValues } from './values.js';

interface DataTableSchemaState {
  columns: readonly DataTableColumn[];
  keyColumn: string | null;
  hasRemovedColumns: boolean;
  revision: number;
}

export function changeDataTableDefinition<T extends DataTableSchemaState>(
  table: T,
  change: DataTableSchemaChange,
  addedColumnId: string,
): T {
  const columns = table.columns.map((column) => ({ ...column }));
  let keyColumn = table.keyColumn;
  let hasRemovedColumns = table.hasRemovedColumns;
  switch (change.operation) {
    case 'add_column':
      if (columns.some((column) => column.name === change.column.name))
        throw new DataTableError(
          'invalid_values',
          'A column already uses that name.',
        );
      columns.push({
        ...change.column,
        id: addedColumnId,
      });
      break;
    case 'rename_column': {
      const column = columns.find((column) => column.id === change.columnId);
      if (column === undefined)
        throw new DataTableError(
          'invalid_values',
          'This column was removed. Refresh the table.',
        );
      if (
        columns.some(
          (other) => other.id !== column.id && other.name === change.name,
        )
      )
        throw new DataTableError(
          'invalid_values',
          'A column already uses that name.',
        );
      if (keyColumn === column.name) keyColumn = change.name;
      column.name = change.name;
      break;
    }
    case 'remove_column': {
      const index = columns.findIndex(
        (column) => column.id === change.columnId,
      );
      const removed = columns[index];
      if (removed === undefined)
        throw new DataTableError(
          'invalid_values',
          'This column was removed. Refresh the table.',
        );
      if (columns.length === 1)
        throw new DataTableError(
          'invalid_values',
          'Keep at least one column. Delete the table to remove all its data.',
        );
      columns.splice(index, 1);
      if (keyColumn === removed.name) keyColumn = null;
      hasRemovedColumns = true;
      break;
    }
    case 'set_key': {
      const column = columns.find((column) => column.id === change.columnId);
      const invalidKeyColumn =
        change.columnId !== null &&
        (column === undefined || !isDataTableKeyColumn(column));
      if (invalidKeyColumn)
        throw new DataTableError(
          'invalid_values',
          'The unique key must be a required text, number or date column.',
        );
      keyColumn = column?.name ?? null;
      break;
    }
  }
  return {
    ...table,
    columns,
    keyColumn,
    hasRemovedColumns,
    revision: table.revision + 1,
  };
}

export function changeDataTableValues(
  oldColumns: readonly DataTableColumn[],
  table: DataTableSchemaState,
  change: DataTableSchemaChange,
  values: DataTableValues,
): DataTableValues {
  const next = Object.fromEntries(
    table.columns.map((column) => {
      const old = oldColumns.find((candidate) => candidate.id === column.id);
      return [
        column.name,
        old === undefined && change.operation === 'add_column'
          ? (change.defaultValue ?? null)
          : (values[old?.name ?? column.name] ?? null),
      ];
    }),
  );
  return validateDataTableValues(table.columns, next);
}
