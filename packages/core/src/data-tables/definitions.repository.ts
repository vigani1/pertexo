import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workspaceDataTableQuotas as quotas,
  workspaceDataTables as tables,
} from '@pertexo/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import type {
  ConfigureTablesInput,
  CreateTableInput,
  DataTableDefinition,
} from './data-table-commands.types.js';

/** Adds the table and counts it against the workspace's quota. */
export async function insertTable(
  client: PoolClient,
  input: CreateTableInput,
  id: string,
  keyColumn: string | null,
): Promise<void> {
  const db = drizzle(client);
  await db
    .insert(tables)
    .values({
      workspaceId: input.workspaceId,
      id,
      name: input.name,
      columns: input.columns.map((column) => ({
        ...column,
        id: column.name,
      })),
      keyColumn,
    })
    .catch(rethrowQueryFailure);
  await db
    .update(quotas)
    .set({ tableCount: sql`${quotas.tableCount}+1` })
    .where(eq(quotas.workspaceId, input.workspaceId))
    .catch(rethrowQueryFailure);
}

/** Removes the table and gives its count and bytes back to the quota. */
export async function deleteTable(
  client: PoolClient,
  workspaceId: string,
  table: DataTableDefinition,
): Promise<void> {
  const db = drizzle(client);
  await db
    .delete(tables)
    .where(and(eq(tables.workspaceId, workspaceId), eq(tables.id, table.id)))
    .catch(rethrowQueryFailure);
  await db
    .update(quotas)
    .set({
      tableCount: sql`${quotas.tableCount}-1`,
      storedBytes: sql`${quotas.storedBytes}-${table.storedBytes}`,
    })
    .where(eq(quotas.workspaceId, workspaceId))
    .catch(rethrowQueryFailure);
}

/** The widest table's columns and the longest table's rows. */
export async function readLargestTableUse(
  client: PoolClient,
  workspaceId: string,
) {
  const db = drizzle(client);
  const [max] = await db
    .select({
      columns: sql<number>`coalesce(max(jsonb_array_length(${tables.columns})),0)::int`,
      rows: sql<number>`coalesce(max(${tables.rowCount}),0)::int`,
    })
    .from(tables)
    .where(eq(tables.workspaceId, workspaceId))
    .catch(rethrowQueryFailure);
  return { columns: max?.columns ?? 0, rows: max?.rows ?? 0 };
}

export async function setQuotaLimits(
  client: PoolClient,
  workspaceId: string,
  limits: Pick<
    ConfigureTablesInput,
    'tableLimit' | 'columnLimit' | 'rowLimit' | 'byteLimit'
  >,
): Promise<void> {
  await drizzle(client)
    .update(quotas)
    .set(limits)
    .where(eq(quotas.workspaceId, workspaceId))
    .catch(rethrowQueryFailure);
}
