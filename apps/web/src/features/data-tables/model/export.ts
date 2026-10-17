import {
  escapeDataTableCsv,
  type DataTableColumn,
  type DataTableRow,
} from '@pertexo/node-sdk';
export function exportTablePage(
  name: string,
  columns: readonly DataTableColumn[],
  rows: readonly DataTableRow[],
): void {
  const csv = [
    columns.map((column) => escapeDataTableCsv(column.name)).join(','),
    ...rows.map((row) =>
      columns
        .map((column) => escapeDataTableCsv(row.values[column.name] ?? null))
        .join(','),
    ),
  ].join('\r\n');
  const url = URL.createObjectURL(
    new Blob([csv], { type: 'text/csv;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}-rows.csv`;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
