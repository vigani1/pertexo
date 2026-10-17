import {
  DataTableError,
  DATA_TABLE_LIMITS,
  type DataTableColumn,
  type DataTableValues,
  type DataTableQuery,
} from './contract.js';
import { inspectBoundedJson } from '../values/bounds.js';

export function validateDataTableValues(
  columns: readonly DataTableColumn[],
  values: DataTableValues,
  partial = false,
): DataTableValues {
  const known = new Set(columns.map((column) => column.name));
  if (Object.keys(values).some((key) => !known.has(key)))
    throw new DataTableError(
      'invalid_values',
      'A value names an unknown column.',
    );
  const result: DataTableValues = {};
  for (const column of columns) {
    if (partial && !Object.hasOwn(values, column.name)) continue;
    const value = values[column.name] ?? null;
    if (value === null) {
      if (column.required)
        throw new DataTableError(
          'invalid_values',
          `Column ${column.name} is required.`,
        );
      result[column.name] = null;
      continue;
    }
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
        valid =
          typeof value === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
          Number.isFinite(Date.parse(value)) &&
          new Date(value).toISOString().slice(0, 10) === value;
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
    Object.defineProperty(result, column.name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const checked = inspectBoundedJson(result, {
    bytes: DATA_TABLE_LIMITS.rowBytes,
    depth: 32,
    members: 8_000,
  });
  if (!checked.ok)
    throw new DataTableError(
      'invalid_values',
      'A row must fit 64 KiB. Split large values.',
    );
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
  return result;
}
export function validateDataTableQuery(
  columns: readonly DataTableColumn[],
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
      true,
    );
  }
  if (
    query.sort !== undefined &&
    !columns.some((column) => column.name === query.sort?.column)
  )
    throw new DataTableError('invalid_values', 'Unknown sort column.');
}
export function dataTableCsvValue(
  column: DataTableColumn,
  text: string,
): unknown {
  if (text === '' && !column.required) return null;
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
export function escapeDataTableCsv(value: unknown): string {
  let text =
    typeof value === 'string'
      ? value
      : value === null
        ? ''
        : JSON.stringify(value);
  if (typeof value === 'string' && /^(?:[=+\-@\t\r\n]|\s+[=+\-@])/u.test(text))
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
