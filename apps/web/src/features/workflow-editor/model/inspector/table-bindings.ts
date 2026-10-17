import type { DataTableBindings, DataTableColumn } from '@pertexo/node-sdk';

/** Reviewing columns is explicit; an existing alias keeps its column's ID. */
export function reviewTableBindings(
  columns: readonly DataTableColumn[],
  current: DataTableBindings | undefined,
): DataTableBindings {
  const existing =
    current ??
    Object.fromEntries(columns.map((column) => [column.id, column.id]));
  const entries = Object.entries(existing).filter(([, id]) =>
    columns.some((column) => column.id === id),
  );
  const names = new Set(entries.map(([name]) => name));
  for (const column of columns) {
    if (entries.some(([, id]) => id === column.id)) continue;
    let alias = column.name;
    let suffix = 1;
    while (names.has(alias)) {
      suffix += 1;
      alias = `${column.name.slice(0, 55)}_${String(suffix)}`;
    }
    entries.push([alias, column.id]);
    names.add(alias);
  }
  return Object.fromEntries(entries);
}
