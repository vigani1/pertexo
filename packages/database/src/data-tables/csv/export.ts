import type { PoolClient } from 'pg';
import type {
  DataTableExportQuery,
  DataTableDefinition,
} from '@pertexo/contracts';
import {
  DataTableError,
  escapeDataTableCsv,
  type DataTableValues,
} from '@pertexo/node-sdk';
import { queryClause } from '../queries.js';
import { requireTable } from '../read.js';

const BATCH_ROWS = 256;
const BATCH_BYTES = 4 * 1024 * 1024;
type ExportRead = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;

/** Each checkout finishes before yielding any bytes to the consumer. */
export function exportTableCsv(
  read: ExportRead,
  workspaceId: string,
  table: DataTableDefinition,
  query: DataTableExportQuery,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const parameters: unknown[] = [workspaceId, table.id];
  // Reject stale filters before the consumer starts a download.
  const where = queryClause(
    table,
    { ...query, limit: 1, offset: 0 },
    parameters,
  );
  const afterParameter = parameters.length + 1;
  const columns = JSON.stringify(table.columns);
  return encodeRows();

  async function* encodeRows(): AsyncGenerator<string> {
    signal?.throwIfAborted();
    yield table.columns
      .map((column) => escapeDataTableCsv(column.name))
      .join(',') + '\r\n';
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
        // The candidate set is bounded on the server; only the byte-bounded prefix
        // crosses the wire. Even a maximum-size row fits this prefix.
        return (
          await client.query<{ id: string; values_json: string }>(
            `with candidates as materialized (
            select id,values_json from app.workspace_data_table_rows
            where workspace_id=$1 and table_id=$2 and ${where}
              and ($${String(afterParameter)}::uuid is null or id>$${String(afterParameter)}::uuid)
            order by id limit ${String(BATCH_ROWS)}
          ), sized as (
            select id,values_json,sum(octet_length(values_json)) over (order by id) as bytes
            from candidates
          ) select id,values_json from sized where bytes<=${String(BATCH_BYTES)} order by id`,
            [...parameters, after],
          )
        ).rows;
      });
      if (batch.length === 0) return;
      for (const row of batch) {
        signal?.throwIfAborted();
        const values = JSON.parse(row.values_json) as DataTableValues;
        yield table.columns
          .map((column) => escapeDataTableCsv(values[column.name] ?? null))
          .join(',') + '\r\n';
        after = row.id;
      }
    }
  }
}
