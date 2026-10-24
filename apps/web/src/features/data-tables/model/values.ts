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

/**
 * What each field says is wrong before the row is sent, by column name. The
 * server still checks the whole row, such as its size.
 */
export function tableValueErrors(
  columns: readonly DataTableColumn[],
  draft: Readonly<Record<string, string>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    columns.map((column) => {
      const text = draft[column.name] ?? '';
      if (text.trim() === '')
        return [column.name, column.required ? 'Enter a value.' : undefined];
      switch (column.type) {
        case 'number':
          return [
            column.name,
            Number.isFinite(Number(text)) ? undefined : 'Enter a number.',
          ];
        case 'boolean':
          return [
            column.name,
            text === 'true' || text === 'false'
              ? undefined
              : 'Choose true or false.',
          ];
        case 'date':
          return [
            column.name,
            isCalendarDay(text) ? undefined : 'Use a date like 2026-10-19.',
          ];
        case 'json':
          return [column.name, isJson(text) ? undefined : 'Enter valid JSON.'];
        case 'text':
          return [column.name, undefined];
      }
    }),
  );
}

function isCalendarDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return false;
  // A day past the month's end rolls over, so it no longer reads the same.
  const day = new Date(`${text}T00:00:00Z`);
  return (
    !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === text
  );
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
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
