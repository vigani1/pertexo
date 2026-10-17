import type { PoolClient } from 'pg';
import type {
  DataTableExportQuery,
  DataTableDefinition,
} from '@pertexo/contracts';
import {
  DATA_TABLE_LIMITS,
  DataTableError,
  escapeDataTableCsv,
  type DataTableValues,
} from '@pertexo/node-sdk';
import { queryClause, rowOrderClause } from '../queries.js';

export async function exportTableCsv(
  client: PoolClient,
  workspaceId: string,
  table: DataTableDefinition,
  query: DataTableExportQuery,
): Promise<{ csv: string; rowCount: number }> {
  const parameters: unknown[] = [workspaceId, table.id];
  const where = queryClause(
    table,
    { ...query, limit: 1, offset: 0 },
    parameters,
  );
  const order = rowOrderClause({ ...query, limit: 1, offset: 0 }, parameters);
  await client.query(
    `declare data_table_export no scroll cursor for select values_json from app.workspace_data_table_rows where workspace_id=$1 and table_id=$2 and ${where} order by ${order}`,
    parameters,
  );
  const lines = [
    table.columns.map((column) => escapeDataTableCsv(column.name)).join(','),
  ];
  let bytes = Buffer.byteLength(lines[0] ?? '');
  let rowCount = 0;
  for (;;) {
    const batch = await client.query<{ values_json: string }>(
      'fetch forward 32 from data_table_export',
    );
    if (batch.rows.length === 0) break;
    for (const row of batch.rows) {
      const values = JSON.parse(row.values_json) as DataTableValues;
      const line = table.columns
        .map((column) => escapeDataTableCsv(values[column.name] ?? null))
        .join(',');
      bytes += 2 + Buffer.byteLength(line);
      if (bytes > DATA_TABLE_LIMITS.resultBytes)
        throw new DataTableError(
          'result_too_large',
          'The complete CSV exceeds 1 MB. Narrow the filter and export the matching rows; no partial export was downloaded.',
        );
      lines.push(line);
      rowCount += 1;
    }
  }
  await client.query('close data_table_export');
  return { csv: lines.join('\r\n'), rowCount };
}
