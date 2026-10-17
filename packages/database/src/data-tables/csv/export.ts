import type { PoolClient, QueryResult } from 'pg';
import type {
  DataTableExportQuery,
  DataTableDefinition,
} from '@pertexo/contracts';
import { escapeDataTableCsv, type DataTableValues } from '@pertexo/node-sdk';
import { queryClause } from '../queries.js';

/** One batch is at most 1 MiB of stored rows; the consumer controls progress. */
export async function* exportTableCsv(
  client: PoolClient,
  workspaceId: string,
  table: DataTableDefinition,
  query: DataTableExportQuery,
): AsyncGenerator<string> {
  const parameters: unknown[] = [workspaceId, table.id];
  const where = queryClause(
    table,
    { ...query, limit: 1, offset: 0 },
    parameters,
  );
  const afterParameter = parameters.length + 1;
  yield table.columns
    .map((column) => escapeDataTableCsv(column.name))
    .join(',') + '\r\n';
  let after: string | null = null;
  for (;;) {
    const batch: QueryResult<{ id: string; values_json: string }> =
      await client.query(
        `select id,values_json from app.workspace_data_table_rows where workspace_id=$1 and table_id=$2 and ${where} and ($${String(afterParameter)}::uuid is null or id>$${String(afterParameter)}::uuid) order by id limit 16`,
        [...parameters, after],
      );
    for (const row of batch.rows) {
      const values = JSON.parse(row.values_json) as DataTableValues;
      yield table.columns
        .map((column) => escapeDataTableCsv(values[column.name] ?? null))
        .join(',') + '\r\n';
      after = row.id;
    }
    if (batch.rows.length < 16) return;
  }
}
