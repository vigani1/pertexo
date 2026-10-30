import {
  DataTableError,
  DATA_TABLE_JSON_LIMITS,
  type DataTableNewColumn,
  type DataTableValues,
  type DataTableQuery,
} from './contract.js';
import { inspectBoundedJson } from '../values/bounds.js';

export function validateDataTableValues(
  columns: readonly DataTableNewColumn[],
  values: DataTableValues,
  options: Readonly<{ partial?: boolean }> = {},
): DataTableValues {
  const partial = options.partial ?? false;
  const known = new Set(columns.map((column) => column.name));
  if (Object.keys(values).some((key) => !known.has(key)))
    throw new DataTableError(
      'invalid_values',
      'A value names an unknown column.',
    );
  const result: DataTableValues = {};
  for (const column of columns) {
    if (partial && !Object.hasOwn(values, column.name)) continue;
    const value = Object.hasOwn(values, column.name)
      ? (values[column.name] ?? null)
      : null;
    if (value === null) {
      if (column.required)
        throw new DataTableError(
          'invalid_values',
          `Column ${column.name} is required.`,
        );
      result[column.name] = null;
      continue;
    }
    assertColumnValue(column, value);
    Object.defineProperty(result, column.name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const checked = inspectBoundedJson(result, DATA_TABLE_JSON_LIMITS);
  if (!checked.ok)
    throw new DataTableError(
      'invalid_values',
      'A row must fit 64 KiB. Split large values.',
    );
  assertStoredRowText(result);
  return result;
}
export function validateDataTableQuery(
  columns: readonly DataTableNewColumn[],
  query: DataTableQuery,
): void {
  for (const filter of query.filters) {
    const column = columns.find((item) => item.name === filter.column);
    if (column === undefined)
      throw new DataTableError(
        'invalid_values',
        `Unknown filter column ${filter.column}.`,
      );
    if (
      filter.value === null &&
      !['equals', 'not_equals'].includes(filter.operator)
    )
      throw new DataTableError(
        'invalid_values',
        'Enter a value for a comparison filter. Use Equals to find empty cells.',
      );
    if (filter.operator === 'contains' && column.type !== 'text')
      throw new DataTableError(
        'invalid_values',
        'Contains is available for text columns.',
      );
    if (
      ['greater_than', 'less_than'].includes(filter.operator) &&
      !['number', 'date', 'text'].includes(column.type)
    )
      throw new DataTableError(
        'invalid_values',
        'Ordering needs a number, date or text column.',
      );
    validateDataTableValues(
      [{ ...column, required: false }],
      { [column.name]: filter.value },
      { partial: true },
    );
  }
  if (
    query.sort !== undefined &&
    !columns.some((column) => column.name === query.sort?.column)
  )
    throw new DataTableError('invalid_values', 'Unknown sort column.');
}
export function dataTableCsvValue(
  column: DataTableNewColumn,
  text: string,
): unknown {
  // An empty cell is no value; a required column then says it's required.
  if (text === '') return null;
  if (
    column.type === 'number' &&
    text.trim() !== '' &&
    Number.isFinite(Number(text))
  )
    return Number(text);
  if (column.type === 'boolean') {
    if (text === 'true') return true;
    if (text === 'false') return false;
  }
  if (column.type === 'json') {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new DataTableError(
        'invalid_values',
        `Column ${column.name} needs JSON.`,
      );
    }
  }
  return text;
}

function assertColumnValue(
  column: DataTableNewColumn,
  value: Exclude<DataTableValues[string], null>,
): void {
  // A required text column needs words, not an empty or blank cell.
  if (column.required && typeof value === 'string' && value.trim() === '')
    throw new DataTableError(
      'invalid_values',
      `Column ${column.name} is required.`,
    );
  let valid: boolean;
  switch (column.type) {
    case 'text':
      valid = typeof value === 'string';
      break;
    case 'number':
      valid = typeof value === 'number' && Number.isFinite(value);
      break;
    case 'boolean':
      valid = typeof value === 'boolean';
      break;
    case 'date':
      valid = isDateOnly(value);
      break;
    case 'json':
      valid = true;
      break;
  }
  if (!valid)
    throw new DataTableError(
      'invalid_values',
      `Column ${column.name} needs ${column.type}.`,
    );
}

function assertStoredRowText(result: DataTableValues): void {
  // PostgreSQL text requires valid Unicode without null characters.
  const pending: unknown[] = [result];
  while (pending.length > 0) {
    const item = pending.pop();
    if (
      typeof item === 'string' &&
      (!item.isWellFormed() || item.includes('\u0000'))
    )
      throw new DataTableError(
        'invalid_values',
        'Values must use valid UTF-8 text without null characters.',
      );
    if (item !== null && typeof item === 'object') {
      for (const [key, value] of Object.entries(item)) {
        if (!key.isWellFormed() || key.includes('\u0000'))
          throw new DataTableError(
            'invalid_values',
            'Column and JSON property names must use valid text.',
          );
        pending.push(value);
      }
    }
  }
}

function isDateOnly(value: unknown): boolean {
  const validDate =
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
  return validDate;
}
