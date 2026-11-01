import type { PoolClient } from 'pg';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DataTableError, DATA_TABLE_LIMITS } from '@pertexo/node-sdk';
import {
  workspaceDataTables as tables,
  workspaceDataTableQuotas as quotas,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { DataTableDefinition, DataTableQuotas } from './contract.js';

export const tableFields = {
  id: tables.id,
  name: tables.name,
  columns: tables.columns,
  hasRemovedColumns: tables.hasRemovedColumns,
  keyColumn: tables.keyColumn,
  rowCount: tables.rowCount,
  storedBytes: tables.storedBytes,
  revision: tables.revision,
};

export async function requireTable(
  client: PoolClient,
  workspaceId: string,
  identity: { id: string } | { name: string },
  { lock = false }: Readonly<{ lock?: boolean | undefined }> = {},
): Promise<DataTableDefinition> {
  let query = drizzle(client)
    .select(tableFields)
    .from(tables)
    .where(
      and(
        eq(tables.workspaceId, workspaceId),
        'id' in identity
          ? eq(tables.id, identity.id)
          : eq(tables.name, identity.name),
      ),
    )
    .$dynamic();
  if (lock) query = query.for('update');
  const [row] = await query.catch(rethrowQueryFailure);
  if (row === undefined)
    throw new DataTableError(
      'not_found',
      'This data table is unavailable. Select an existing workspace table.',
    );
  return row;
}

export async function readQuotas(
  client: PoolClient,
  workspaceId: string,
  { lock = false }: Readonly<{ lock?: boolean | undefined }> = {},
): Promise<DataTableQuotas> {
  const db = drizzle(client);
  if (lock)
    await db
      .insert(quotas)
      .values({ workspaceId })
      .onConflictDoNothing()
      .catch(rethrowQueryFailure);
  let query = db
    .select({
      tableLimit: quotas.tableLimit,
      columnLimit: quotas.columnLimit,
      rowLimit: quotas.rowLimit,
      byteLimit: quotas.byteLimit,
      tableCount: quotas.tableCount,
      storedBytes: quotas.storedBytes,
    })
    .from(quotas)
    .where(eq(quotas.workspaceId, workspaceId))
    .$dynamic();
  if (lock) query = query.for('update');
  const [row] = await query.catch(rethrowQueryFailure);
  return (
    row ?? {
      tableLimit: DATA_TABLE_LIMITS.tables,
      columnLimit: DATA_TABLE_LIMITS.columns,
      rowLimit: DATA_TABLE_LIMITS.rows,
      byteLimit: DATA_TABLE_LIMITS.bytes,
      tableCount: 0,
      storedBytes: 0,
    }
  );
}

/** Referenced definitions stay fixed through admission or promotion. */
export async function readTablesByNames(
  db: Pick<NodePgDatabase, 'select'>,
  workspaceId: string,
  names: readonly string[],
): Promise<DataTableDefinition[]> {
  if (names.length === 0) return [];
  return db
    .select(tableFields)
    .from(tables)
    .where(
      and(
        eq(tables.workspaceId, workspaceId),
        inArray(tables.name, [...new Set(names)]),
      ),
    )
    .orderBy(tables.id)
    .for('share');
}
