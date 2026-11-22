import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workspaceMemberships, workspaces } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

import { PURGE_PRESERVED_TABLES } from './steps.js';

/** The name a purged workspace's tombstone keeps. */
const TOMBSTONE_NAME = 'Deleted workspace';

/** A workspace past its recovery period starts purging. */
export async function markWorkspacePurging(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await drizzle(client)
    .update(workspaces)
    .set({ status: 'purging', updatedAt: sql`clock_timestamp()` })
    .where(eq(workspaces.id, workspaceId))
    .catch(rethrowQueryFailure);
}

/** False when another worker holds the purging workspace, or has finished it. */
export async function lockPurgingWorkspace(
  client: PoolClient,
  workspaceId: string,
): Promise<boolean> {
  const locked = await drizzle(client)
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(eq(workspaces.id, workspaceId), eq(workspaces.status, 'purging')),
    )
    .for('update', { skipLocked: true })
    .catch(rethrowQueryFailure);
  return locked.length === 1;
}

/** Discovery must survive object erasure and disappear with the tombstone. */
export async function deleteWorkspaceMemberships(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await drizzle(client)
    .delete(workspaceMemberships)
    .where(eq(workspaceMemberships.workspaceId, workspaceId))
    .catch(rethrowQueryFailure);
}

/** Every live `app` table with a workspace column that purge must empty. */
export async function listWorkspaceTables(
  client: PoolClient,
): Promise<readonly string[]> {
  const tables = await drizzle(client)
    .selectDistinct({ name: sql<string>`table_class.relname`.as('name') })
    .from(sql`pg_catalog.pg_attribute attribute`)
    .innerJoin(
      sql`pg_catalog.pg_class table_class`,
      sql`table_class.oid=attribute.attrelid`,
    )
    .innerJoin(
      sql`pg_catalog.pg_namespace namespace`,
      sql`namespace.oid=table_class.relnamespace`,
    )
    .where(
      sql`namespace.nspname='app' and table_class.relkind='r' and attribute.attname='workspace_id' and not attribute.attisdropped and not table_class.relname=any(${sql.param(PURGE_PRESERVED_TABLES)}::text[])`,
    )
    .orderBy(asc(sql`table_class.relname`))
    .catch(rethrowQueryFailure);
  return tables.map(({ name }) => name);
}

/** Whether the `app` table still holds any of the workspace's rows. */
export async function hasWorkspaceRows(
  client: PoolClient,
  table: string,
  workspaceId: string,
): Promise<boolean> {
  const left = await drizzle(client)
    .select({ one: sql`1` })
    .from(sql`${sql.identifier('app')}.${sql.identifier(table)}`)
    .where(sql`${sql.identifier('workspace_id')}=${workspaceId}::uuid`)
    .limit(1)
    .catch(rethrowQueryFailure);
  return left.length !== 0;
}

/** The workspace row stays as a tombstone, without its name or people. */
export async function leaveWorkspaceTombstone(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await drizzle(client)
    .update(workspaces)
    .set({
      status: 'deleted',
      assistantConnectionId: null,
      assistantModel: null,
      name: TOMBSTONE_NAME,
      slug: sql`'deleted-'||${workspaces.id}::text`,
      createdBy: null,
      deletionRequestedBy: null,
      deletionReason: 'purged',
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(workspaces.id, workspaceId))
    .catch(rethrowQueryFailure);
}
