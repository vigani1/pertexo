import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { and, eq, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import {
  workspaceDataTableQuotas as quotas,
  workspaceDataTableRows as tableRows,
  workspaceDataTables as tables,
} from '@pertexo/database/schema';
import type {
  DataTableDefinition,
  EditTableSchemaInput,
} from '../data-table-commands.types.js';

/** Rows rewrite in batches of this many. */
const REWRITE_BATCH_ROWS = 64;

/** Stores the new definition and moves the workspace's byte total by the change. */
export async function saveTableSchema(
  client: PoolClient,
  input: EditTableSchemaInput,
  {
    table,
    next,
    bytes,
  }: Readonly<{
    table: DataTableDefinition;
    next: DataTableDefinition;
    bytes: number;
  }>,
): Promise<void> {
  const db = drizzle(client);
  await db
    .update(tables)
    .set({
      columns: next.columns,
      keyColumn: next.keyColumn,
      hasRemovedColumns: next.hasRemovedColumns,
      storedBytes: bytes,
      revision: sql`${tables.revision}+1`,
    })
    .where(
      and(eq(tables.workspaceId, input.workspaceId), eq(tables.id, table.id)),
    )
    .catch(rethrowQueryFailure);
  await db
    .update(quotas)
    .set({
      storedBytes: sql`${quotas.storedBytes}+${bytes - table.storedBytes}`,
    })
    .where(eq(quotas.workspaceId, input.workspaceId))
    .catch(rethrowQueryFailure);
}

export async function clearRowKeys(
  client: PoolClient,
  input: EditTableSchemaInput,
  tableId: string,
): Promise<void> {
  await drizzle(client)
    .update(tableRows)
    .set({ keyValue: null })
    .where(
      and(
        eq(tableRows.workspaceId, input.workspaceId),
        eq(tableRows.tableId, tableId),
      ),
    )
    .catch(rethrowQueryFailure);
}

/** The next batch of rows after `after`, in ID order. */
export async function readRewriteBatch(
  client: PoolClient,
  input: EditTableSchemaInput,
  tableId: string,
  after: string | null,
) {
  const db = drizzle(client);
  const batch: Pick<
    typeof tableRows.$inferSelect,
    'id' | 'values' | 'revision'
  >[] = await db
    .select({
      id: tableRows.id,
      values: tableRows.values,
      revision: tableRows.revision,
    })
    .from(tableRows)
    .where(
      and(
        eq(tableRows.workspaceId, input.workspaceId),
        eq(tableRows.tableId, tableId),
        after === null ? undefined : gt(tableRows.id, after),
      ),
    )
    .orderBy(tableRows.id)
    .limit(REWRITE_BATCH_ROWS)
    .catch(rethrowQueryFailure);
  return batch;
}

type RowChange = Pick<
  typeof tableRows.$inferSelect,
  'id' | 'values' | 'keyValue' | 'revision'
>;

export async function writeRowChanges(
  client: PoolClient,
  {
    workspaceId,
    tableId,
    changes,
  }: Readonly<{
    workspaceId: string;
    tableId: string;
    changes: readonly RowChange[];
  }>,
): Promise<void> {
  // The table lock keeps these IDs present, so a bulk upsert preserves the
  // existing-row rewrite without issuing a write for each row.
  const excluded = alias(tableRows, 'excluded');
  await drizzle(client)
    .insert(tableRows)
    .values(changes.map((row) => ({ workspaceId, tableId, ...row })))
    .onConflictDoUpdate({
      target: tableRows.id,
      set: {
        values: excluded.values,
        keyValue: excluded.keyValue,
        revision: excluded.revision,
      },
      setWhere: sql`${tableRows.workspaceId}=${workspaceId} and ${tableRows.tableId}=${tableId}`,
    })
    .catch(rethrowQueryFailure);
}
