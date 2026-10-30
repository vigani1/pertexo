import {
  DataTableError,
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
      return [column.name, editableCellValue(value, column.type)];
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

/** The words a field uses when the shared check refuses its type. */
const FIELD_PROBLEMS: Readonly<
  Partial<Record<DataTableColumn['type'], string>>
> = {
  number: 'Enter a number.',
  boolean: 'Choose true or false.',
  date: 'Use a date like 2026-10-19.',
  json: 'Enter valid JSON.',
};

/**
 * What each field says is wrong before the row is sent, by column name: the
 * shared check submitting would run, one column at a time. The server still
 * checks the whole row, such as its size.
 */
export function tableValueErrors(
  columns: readonly DataTableColumn[],
  draft: Readonly<Record<string, string>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    columns.map((column) => [column.name, fieldProblem(column, draft)]),
  );
}

function fieldProblem(
  column: DataTableColumn,
  draft: Readonly<Record<string, string>>,
): string | undefined {
  const text = draft[column.name] ?? '';
  try {
    readTableValues([column], { [column.name]: text });
    return undefined;
  } catch (cause) {
    if (!(cause instanceof DataTableError)) throw cause;
    if (column.required && text.trim() === '') return 'Enter a value.';
    return FIELD_PROBLEMS[column.type] ?? cause.message;
  }
}

/** How a cell reads in the rows table; an empty cell is undefined. */
export function tableCellText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

function editableCellValue(
  value: DataTableValues[string] | undefined,
  type: DataTableColumn['type'],
): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, type === 'json' ? 2 : undefined);
}
