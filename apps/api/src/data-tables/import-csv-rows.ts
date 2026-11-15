import { parse } from 'csv-parse/sync';
import {
  DataTableError,
  DATA_TABLE_LIMITS,
  formatByteSize,
  dataTableCsvValue,
  type DataTableValues,
} from '@pertexo/node-sdk';
import type {
  DataTablesStore,
  DataTableDefinition,
  ImportRowsInput,
} from '@pertexo/core/data-tables';

// Line 1 is the header, so the first row is line 2.
const CSV_FIRST_DATA_LINE = 2;
/** How many unknown columns a refusal names. */
const UNKNOWN_COLUMNS_NAMED = 5;
/** Imports a CSV file's rows, checked against the table the store locks. */
export async function importCsvRows(
  store: Pick<DataTablesStore, 'importRows'>,
  input: Omit<ImportRowsInput, 'rows' | 'prepareRows'> &
    Readonly<{ csv: string }>,
) {
  try {
    return await store.importRows({
      ...input,
      prepareRows: (table: DataTableDefinition) => parseCsv(input.csv, table),
    });
  } catch (error) {
    if (error instanceof DataTableError && error.rowNumber !== undefined)
      throw new DataTableError(
        error.code,
        `CSV row ${String(error.rowNumber + 1)}: ${error.message}`,
      );
    throw error;
  }
}

function parseCsv(csv: string, table: DataTableDefinition) {
  if (Buffer.byteLength(csv) > DATA_TABLE_LIMITS.csvImportBytes)
    throw new DataTableError(
      'invalid_values',
      `CSV imports must fit ${formatByteSize(DATA_TABLE_LIMITS.csvImportBytes)}. Split the file.`,
    );
  let records: string[][];
  try {
    records = parse(csv, {
      // The header, the batch, and one more row to see that it's too long.
      to: DATA_TABLE_LIMITS.batchRows + CSV_FIRST_DATA_LINE,
      bom: true,
      skip_empty_lines: true,
      max_record_size: DATA_TABLE_LIMITS.rowBytes,
      relax_column_count: false,
    });
  } catch {
    throw new DataTableError(
      'invalid_values',
      'The CSV is malformed or a row is too large. Check quoting and column counts, or split the file.',
    );
  }
  const header = records.shift() ?? [];
  checkCsvHeader(header, table);
  if (records.length === 0 || records.length > DATA_TABLE_LIMITS.batchRows)
    throw new DataTableError(
      'invalid_values',
      'Import 1–1,000 rows at a time. Split the file.',
    );
  const rows = records.map((record, index) => {
    try {
      return Object.fromEntries(
        header.map((name, columnIndex) => {
          const column = table.columns.find((item) => item.name === name);
          if (column === undefined)
            throw new DataTableError('invalid_values', 'Unknown column.');
          return [name, dataTableCsvValue(column, record[columnIndex] ?? '')];
        }),
      ) as DataTableValues;
    } catch (error) {
      if (error instanceof DataTableError)
        throw new DataTableError(
          error.code,
          `CSV row ${String(index + CSV_FIRST_DATA_LINE)}: ${error.message}`,
        );
      throw error;
    }
  });
  return rows;
}

/**
 * Like Airtable and n8n, a file may hold some of the columns: the ones it
 * leaves out stay empty, but it names every required column and nothing the
 * table doesn't have.
 */
function checkCsvHeader(
  header: readonly string[],
  table: DataTableDefinition,
): void {
  const fail = (message: string): never => {
    throw new DataTableError('invalid_values', message);
  };
  if (header.length === 0)
    fail('The CSV has no header row. Name the columns in the first row.');
  const repeated = header.find((name, index) => header.indexOf(name) !== index);
  if (repeated !== undefined)
    fail(`The CSV names the column ${repeated} more than once.`);
  const unknown = header.filter(
    (name) => !table.columns.some((column) => column.name === name),
  );
  if (unknown.length > 0)
    fail(
      `The CSV has ${unknown.length === 1 ? 'a column' : 'columns'} this table doesn’t: ${unknown.slice(0, UNKNOWN_COLUMNS_NAMED).join(', ')}. Rename or remove ${unknown.length === 1 ? 'it' : 'them'}.`,
    );
  const missing = table.columns
    .filter((column) => column.required && !header.includes(column.name))
    .map((column) => column.name);
  if (missing.length > 0)
    fail(
      `The CSV is missing the required ${missing.length === 1 ? 'column' : 'columns'} ${missing.join(', ')}.`,
    );
}
