import { parse } from 'csv-parse/sync';
import {
  DataTableError,
  DATA_TABLE_LIMITS,
  dataTableCsvValue,
} from '@pertexo/node-sdk';
import type { DataTablesStore } from '@pertexo/database/data-tables';
export class DataTablesService {
  constructor(readonly store: DataTablesStore) {}
  async importCsv(
    input: Parameters<DataTablesStore['importRows']>[0] &
      Readonly<{ csv: string }>,
  ) {
    if (Buffer.byteLength(input.csv) > 1_048_576)
      throw new DataTableError(
        'invalid_values',
        'CSV imports must fit 1 MB. Split the file.',
      );
    const table = (await this.store.list(input)).tables.find(
      (item) => item.id === input.tableId,
    );
    if (table === undefined)
      throw new DataTableError('not_found', 'This data table is unavailable.');
    let records: string[][];
    try {
      records = parse(input.csv, {
        to: DATA_TABLE_LIMITS.batchRows + 2,
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
    const header = records.shift();
    if (
      new Set(header).size !== header?.length ||
      header.length !== table.columns.length ||
      header.some(
        (name) => !table.columns.some((column) => column.name === name),
      )
    )
      throw new DataTableError(
        'invalid_values',
        'CSV headers must name each table column exactly once.',
      );
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
        ) as Parameters<DataTablesStore['importRows']>[0]['rows'][number];
      } catch (error) {
        if (error instanceof DataTableError)
          throw new DataTableError(
            error.code,
            `CSV row ${String(index + 2)}: ${error.message}`,
          );
        throw error;
      }
    });
    try {
      return await this.store.importRows({ ...input, rows });
    } catch (error) {
      if (error instanceof DataTableError && error.rowNumber !== undefined)
        throw new DataTableError(
          error.code,
          `CSV row ${String(error.rowNumber + 1)}: ${error.message}`,
        );
      throw error;
    }
  }
}
