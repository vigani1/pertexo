import {
  dataTableCsvValue,
  validateDataTableValues,
  type DataTableColumn,
  type DataTableValues,
} from '@pertexo/node-sdk';
export function editTableValues(
  columns: readonly DataTableColumn[],
  values: DataTableValues | undefined,
): Record<string, string> {
  return Object.fromEntries(
    columns.map((column) => {
      const value = values?.[column.name];
      return [
        column.name,
        value === null || value === undefined
          ? ''
          : typeof value === 'string'
            ? value
            : JSON.stringify(
                value,
                null,
                column.type === 'json' ? 2 : undefined,
              ),
      ];
    }),
  );
}
export function readTableValues(
  columns: readonly DataTableColumn[],
  draft: Readonly<Record<string, string>>,
) {
  return validateDataTableValues(
    columns,
    Object.fromEntries(
      columns.map((column) => [
        column.name,
        dataTableCsvValue(column, draft[column.name] ?? ''),
      ]),
    ) as DataTableValues,
  );
}
