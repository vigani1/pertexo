import { decodeStoredValue } from '../shared/stored-values.js';
import type {
  DataTableDefinition,
  DataTableExportQuery,
} from '@pertexo/contracts';
import {
  DataTableError,
  dataTableValuesSchema,
  escapeCsvValue,
  validateDataTableQuery,
} from '@pertexo/node-sdk';
import type { PoolClient } from 'pg';
import type { ExportTableInput } from './data-table-commands.types.js';
import { requireTable } from './require-table.js';
import { queryClause, readExportBatch } from './rows/find.repository.js';

type ExportRead = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

export async function exportTable(read: ExportRead, input: ExportTableInput) {
  const table = await read((client) =>
    requireTable(client, input.workspaceId, { id: input.tableId }),
  );
  const csv = exportTableCsv(read, input.workspaceId, {
    table,
    query: input.query,
    signal: input.signal,
  });
  await input.consume(csv, table);
}

/** Each checkout finishes before yielding any bytes to the consumer. */
function exportTableCsv(
  read: ExportRead,
  workspaceId: string,
  {
    table,
    query,
    signal,
  }: Readonly<{
    table: DataTableDefinition;
    query: DataTableExportQuery;
    signal?: AbortSignal | undefined;
  }>,
): AsyncGenerator<string> {
  // Reject stale filters before the consumer starts a download.
  const exportQuery = { ...query, limit: 1, offset: 0 };
  validateDataTableQuery(table.columns, exportQuery);
  const where = queryClause(table, exportQuery);
  const columns = JSON.stringify(table.columns);
  return encodeRows();

  async function* encodeRows(): AsyncGenerator<string> {
    signal?.throwIfAborted();
    yield table.columns.map((column) => escapeCsvValue(column.name)).join(',') +
      '\r\n';
    let after: string | null = null;
    for (;;) {
      signal?.throwIfAborted();
      const batch = await read(async (client) => {
        const current = await requireTable(client, workspaceId, {
          id: table.id,
        });
        if (JSON.stringify(current.columns) !== columns)
          throw new DataTableError(
            'conflict',
            'The table columns changed during export. Download it again.',
          );
        return readExportBatch(client, {
          workspaceId,
          tableId: table.id,
          where,
          after,
        });
      });
      if (batch.length === 0) return;
      for (const row of batch) {
        signal?.throwIfAborted();
        const values = decodeStoredValue(() =>
          dataTableValuesSchema.parse(JSON.parse(row.valuesText)),
        );
        yield table.columns
          .map((column) => escapeCsvValue(values[column.name] ?? null))
          .join(',') + '\r\n';
        after = row.id;
      }
    }
  }
}
