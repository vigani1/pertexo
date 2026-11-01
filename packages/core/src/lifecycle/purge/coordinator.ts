import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workspaces } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { z } from 'zod';
import { claimPurgeWorkspace } from './directory.repository.js';

import type { Pool, PoolClient } from 'pg';

import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { acquireDatabasePool } from '@pertexo/database/platform';
import { inRetentionTransaction } from '../retention/transaction.js';
import type {
  WorkspacePurgeObjectStore,
  WorkspacePurgeProcessResult,
  WorkspacePurgeCoordinator,
  WorkspacePurgeOptions,
} from './contract.js';
import { optionsSchema } from './input.js';
import { PURGE_PRESERVED_TABLES, PURGE_STEPS } from './steps.js';

/** Fails if a workspace table still holds the purged workspace's rows. */
async function assertNothingLeft(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  const db = drizzle(client);
  const tables = await db
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
  for (const { name } of tables) {
    // Discover every live relation so an unlisted table can never pass completion.
    const left = await db
      .select({ one: sql`1` })
      .from(sql`${sql.identifier('app')}.${sql.identifier(name)}`)
      .where(sql`${sql.identifier('workspace_id')}=${workspaceId}::uuid`)
      .limit(1)
      .catch(rethrowQueryFailure);
    if (left.length !== 0)
      throw new Error(`Workspace purge left rows in ${name}`);
  }
}

/**
 * Purges workspaces whose recovery period has ended. Each call does one
 * bounded unit of work for one workspace: it starts a purge, removes one
 * page of rows or stored objects, or finishes the purge by leaving a
 * tombstone. Any number of workers can call it; each takes a different
 * workspace while it changes rows.
 */
export function createWorkspacePurgeCoordinator(
  config: DatabaseConfig,
  objectStore: WorkspacePurgeObjectStore,
  inputOptions: WorkspacePurgeOptions = {},
  runtime?: DatabaseRuntime,
): WorkspacePurgeCoordinator {
  const options = optionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;
  return Object.freeze({
    close: () => lease.close(),
    processNext: async (signal?: AbortSignal) => {
      const rows = await purgeRows({ pool, options }, signal);
      if (!('rowsPurged' in rows)) return rows;
      const workspaceId = rows.rowsPurged;
      // Stored objects go after rows and outside any transaction.
      const objects = await objectStore.purgeWorkspacePage({
        maxObjects: options.objectPageSize,
        signal: AbortSignal.any([
          ...(signal === undefined ? [] : [signal]),
          AbortSignal.timeout(options.objectTimeoutMs),
        ]),
        workspaceId,
      });
      if (!objects.completed)
        return Object.freeze({
          status: 'progressed' as const,
          workspaceId,
          step: 'objects',
        });
      return finishPurge({ pool, options }, workspaceId, signal);
    },
  });
}

type PurgeContext = Readonly<{
  pool: Pool;
  options: z.output<typeof optionsSchema>;
}>;
async function purgeRows(
  { pool, options }: PurgeContext,
  signal: AbortSignal | undefined,
): Promise<WorkspacePurgeProcessResult | Readonly<{ rowsPurged: string }>> {
  return inRetentionTransaction(pool, options, signal, async (client) => {
    const candidate = await claimPurgeWorkspace(client);
    if (candidate === undefined) return { status: 'idle' as const };
    const workspace = candidate;
    if (workspace.status === 'pending_deletion') {
      await drizzle(client)
        .update(workspaces)
        .set({ status: 'purging', updatedAt: sql`clock_timestamp()` })
        .where(eq(workspaces.id, workspace.id))
        .catch(rethrowQueryFailure);
      return { status: 'started' as const, workspaceId: workspace.id };
    }
    await drizzle(client)
      .execute(sql`select set_config('app.workspace_id',${workspace.id},true)`)
      .catch(rethrowQueryFailure);
    for (const step of PURGE_STEPS) {
      const changed = await step.run(client, workspace.id, options.pageSize);
      if (changed > 0)
        return {
          status: 'progressed' as const,
          workspaceId: workspace.id,
          step: step.name,
        };
    }
    return { rowsPurged: workspace.id };
  });
}
async function finishPurge(
  { pool, options }: PurgeContext,
  workspaceId: string,
  signal: AbortSignal | undefined,
): Promise<WorkspacePurgeProcessResult> {
  return inRetentionTransaction(pool, options, signal, async (client) => {
    const locked = await drizzle(client)
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(eq(workspaces.id, workspaceId), eq(workspaces.status, 'purging')),
      )
      .for('update', { skipLocked: true })
      .catch(rethrowQueryFailure);
    // Another worker owns it, or has finished it.
    if (locked.length !== 1) return { status: 'idle' as const };
    await assertNothingLeft(client, workspaceId);
    await drizzle(client)
      .update(workspaces)
      .set({
        status: 'deleted',
        name: 'Deleted workspace',
        slug: sql`'deleted-'||${workspaces.id}::text`,
        createdBy: null,
        deletionRequestedBy: null,
        deletionReason: 'purged',
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workspaces.id, workspaceId))
      .catch(rethrowQueryFailure);
    return { status: 'completed' as const, workspaceId };
  });
}
