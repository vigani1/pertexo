import {
  isUniqueConstraintFailure,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import {
  workspaceDataTableQuotas as quotasTable,
  workspaceDataTableRows as tableRows,
  workspaceDataTables as tables,
} from '@pertexo/database/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

type TableRows = Readonly<{
  client: PoolClient;
  workspaceId: string;
  tableId: string;
}>;

/** A unique-key clash reads as `key_conflict`, with its failure; any other failure throws. */
export type RowWrite =
  | Readonly<{ kind: 'written' }>
  | Readonly<{ kind: 'key_conflict'; error: unknown }>;

export async function deleteRowsById(
  { client, workspaceId, tableId }: TableRows,
  ids: readonly string[],
): Promise<void> {
  await drizzle(client)
    .delete(tableRows)
    .where(
      and(
        eq(tableRows.workspaceId, workspaceId),
        eq(tableRows.tableId, tableId),
        inArray(tableRows.id, [...ids]),
      ),
    )
    .catch(rethrowQueryFailure);
}

export async function insertRowValues(
  { client, workspaceId, tableId }: TableRows,
  row: Readonly<{ id: string; values: string; keyValue: string | null }>,
): Promise<RowWrite> {
  return drizzle(client)
    .insert(tableRows)
    .values({ workspaceId, tableId, ...row })
    .then(
      () => ({ kind: 'written' }) as const,
      (error: unknown) => keyConflict(error),
    );
}

/** Writes every row's new values and key in one statement, bumping revisions. */
export async function patchRowValues(
  { client, workspaceId, tableId }: TableRows,
  updates: readonly Readonly<{
    id: string;
    text: string;
    keyValue: string | null;
  }>[],
): Promise<RowWrite> {
  return drizzle(client)
    .update(tableRows)
    .set({
      values: sql`batch.values_json`,
      keyValue: sql`batch.key_value`,
      revision: sql`${tableRows.revision}+1`,
    })
    .from(
      sql`unnest(${sql.param(updates.map(({ id }) => id))}::uuid[],${sql.param(updates.map(({ text }) => text))}::text[],${sql.param(updates.map((update) => update.keyValue))}::text[]) as batch(id,values_json,key_value)`,
    )
    .where(
      and(
        eq(tableRows.workspaceId, workspaceId),
        eq(tableRows.tableId, tableId),
        sql`${tableRows.id}=batch.id`,
      ),
    )
    .then(
      () => ({ kind: 'written' }) as const,
      (error: unknown) => keyConflict(error),
    );
}

export async function addTableUsage(
  client: PoolClient,
  workspaceId: string,
  tableId: string,
  {
    countDelta,
    byteDelta,
  }: Readonly<{ countDelta: number; byteDelta: number }>,
): Promise<void> {
  const db = drizzle(client);
  await db
    .update(tables)
    .set({
      rowCount: sql`${tables.rowCount}+${countDelta}`,
      storedBytes: sql`${tables.storedBytes}+${byteDelta}`,
      revision: sql`${tables.revision}+1`,
    })
    .where(and(eq(tables.workspaceId, workspaceId), eq(tables.id, tableId)))
    .catch(rethrowQueryFailure);
  await db
    .update(quotasTable)
    .set({ storedBytes: sql`${quotasTable.storedBytes}+${byteDelta}` })
    .where(eq(quotasTable.workspaceId, workspaceId))
    .catch(rethrowQueryFailure);
}

export async function insertRowBatch(
  { client, workspaceId, tableId }: TableRows,
  records: readonly Readonly<{
    id: string;
    values: string;
    keyValue: string | null;
  }>[],
): Promise<void> {
  await drizzle(client)
    .insert(tableRows)
    .values(records.map((row) => ({ workspaceId, tableId, ...row })))
    .catch(rethrowQueryFailure);
}

function keyConflict(error: unknown): RowWrite {
  if (!isUniqueConstraintFailure(error)) return rethrowQueryFailure(error);
  return { kind: 'key_conflict', error };
}
