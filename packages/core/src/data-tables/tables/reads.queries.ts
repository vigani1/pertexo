import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workspaceDataTables } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { Pool } from 'pg';

import type { DataTablesStore } from '../contract.js';
import {
  readQuotas,
  requireTable,
  tableFields,
} from '../definitions.queries.js';
import { findRows } from '../rows/find.queries.js';

import { exportTableCsv } from '../csv/export.js';

import { read } from '../command.js';

export function listTables(
  pool: Pool,
  input: Parameters<DataTablesStore['list']>[0],
): ReturnType<DataTablesStore['list']> {
  return read(pool, input, async (client) => ({
    quotas: await readQuotas(client, input.workspaceId),
    tables: await drizzle(client)
      .select(tableFields)
      .from(workspaceDataTables)
      .where(eq(workspaceDataTables.workspaceId, input.workspaceId))
      .orderBy(workspaceDataTables.name)
      .limit(100)
      .catch(rethrowQueryFailure),
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
