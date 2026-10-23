import {
  DataTableError,
  isDataTableResultBounded,
  type DataTableBindings,
  type DataTableColumn,
  type DataTableCommand,
  type DataTableQuery,
  type DataTableResult,
} from './contract.js';

/** Stable workflow aliases resolve to the current names used by table rows. */
export function resolveDataTableBindings({
  columns,
  bindings,
  hasRemovedColumns,
}: Readonly<{
  columns: readonly DataTableColumn[];
  bindings: DataTableBindings | undefined;
  hasRemovedColumns: boolean;
}>): Readonly<Record<string, string>> {
  if (bindings === undefined && hasRemovedColumns)
    throw new DataTableError(
      'invalid_values',
      'This legacy table step needs column review after a column was removed. Select its table columns and publish again.',
    );
  const references =
    bindings ??
    Object.fromEntries(columns.map((column) => [column.id, column.id]));
  return Object.fromEntries(
    Object.entries(references).map(([alias, id]) => {
      const column = columns.find((candidate) => candidate.id === id);
      if (column === undefined)
        throw new DataTableError(
          'invalid_values',
          `Mapped column ${alias} was removed or is unavailable. Review this step’s table columns.`,
        );
      return [alias, column.name];
    }),
  );
}

export function bindDataTableCommand(
  command: DataTableCommand,
  names: Readonly<Record<string, string>>,
): DataTableCommand {
  const name = (alias: string) => {
    const resolved = Object.hasOwn(names, alias) ? names[alias] : undefined;
    if (resolved === undefined)
      throw new DataTableError(
        'invalid_values',
        `Column ${alias} is not bound. Review this step’s table columns.`,
      );
    return resolved;
  };
  const query = (value: DataTableQuery): DataTableQuery => ({
    ...value,
    filters: value.filters.map((filter) => ({
      ...filter,
      column: name(filter.column),
    })),
    ...(value.sort === undefined
      ? {}
      : { sort: { ...value.sort, column: name(value.sort.column) } }),
  });
  switch (command.operation) {
    case 'find':
    case 'delete':
      return { ...command, query: query(command.query) };
    case 'insert':
    case 'upsert':
      return {
        ...command,
        values: Object.fromEntries(
          Object.entries(command.values).map(([alias, value]) => [
            name(alias),
            value,
          ]),
        ),
      };
    case 'update':
      return {
        ...command,
        query: query(command.query),
        values: Object.fromEntries(
          Object.entries(command.values).map(([alias, value]) => [
            name(alias),
            value,
          ]),
        ),
      };
  }
}

export function projectBoundDataTableResult(
  result: DataTableResult,
  names: Readonly<Record<string, string>>,
): DataTableResult {
  const projected = {
    ...result,
    rows: result.rows.map((row) => ({
      ...row,
      values: Object.fromEntries(
        Object.entries(names).map(([alias, name]) => [
          alias,
          row.values[name] ?? null,
        ]),
      ),
    })),
  };
  if (!isDataTableResultBounded(projected))
    throw new DataTableError(
      'result_too_large',
      'The bound table result exceeds the execution value limits. Narrow the filter or lower the row limit.',
    );
  return projected;
}
