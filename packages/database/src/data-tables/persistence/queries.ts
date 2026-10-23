import type { Pool } from 'pg';

import type { DataTablesStore } from '../contract.js';
import {
  readQuotas,
  requireTable,
  projectTable,
  TABLE_COLUMNS,
  type StoredTable,
} from '../read.js';
import { findRows } from '../queries.js';

import { exportTableCsv } from '../csv/export.js';

import { read } from './session.js';

export function listTables(
  pool: Pool,
  input: Parameters<DataTablesStore['list']>[0],
): ReturnType<DataTablesStore['list']> {
  return read(pool, input, async (client) => ({
    quotas: await readQuotas(client, input.workspaceId),
    tables: (
      await client.query<StoredTable>(
        `select ${TABLE_COLUMNS} from app.workspace_data_tables where workspace_id=$1 order by name limit 100`,
        [input.workspaceId],
      )
    ).rows.map(projectTable),
  }));
}

export async function exportCsv(
  pool: Pool,
  input: Parameters<DataTablesStore['exportCsv']>[0],
): ReturnType<DataTablesStore['exportCsv']> {
  const table = await read(pool, input, (client) =>
    requireTable(client, input.workspaceId, { id: input.tableId }),
  );
  const csv = exportTableCsv(
    (work) => read(pool, input, work),
    input.workspaceId,
    { table, query: input.query, signal: input.signal },
  );
  await input.consume(csv, table);
}

export function findTableRows(
  pool: Pool,
  input: Parameters<DataTablesStore['find']>[0],
): ReturnType<DataTablesStore['find']> {
  return read(pool, input, async (client) =>
    findRows(
      client,
      input.workspaceId,
      await requireTable(client, input.workspaceId, { id: input.tableId }),
      input.query,
    ),
  );
}
