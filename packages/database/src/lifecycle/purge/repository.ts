import type { z } from 'zod';
import { claimPurgeWorkspace } from '../identity/directory.repository.js';

import type { Pool, PoolClient } from 'pg';

import type { DatabaseConfig } from '../../config.js';
import { acquireDatabasePool } from '../../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';
import { inRetentionTransaction } from '../retention/transactions.repository.js';
import {
  type WorkspacePurgeObjectStore,
  type WorkspacePurgeProcessResult,
  type WorkspacePurgeCoordinator,
  optionsSchema,
  type WorkspacePurgeOptions,
  candidateSchema,
} from './contract.js';
import { PURGE_PRESERVED_TABLES, PURGE_STEPS } from './steps.repository.js';

export {
  type WorkspacePurgeObjectStore,
  type WorkspacePurgeProcessResult,
  type WorkspacePurgeCoordinator,
  type WorkspacePurgeOptions,
} from './contract.js';
export { PURGE_PRESERVED_TABLES, PURGE_STEPS } from './steps.repository.js';
/** Fails if a workspace table still holds the purged workspace's rows. */
async function assertNothingLeft(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  const tables = await client.query<{ name: string }>(
    `select distinct table_class.relname as name
     from pg_attribute attribute
     join pg_class table_class on table_class.oid = attribute.attrelid
     join pg_namespace namespace on namespace.oid = table_class.relnamespace
     where namespace.nspname = 'app' and table_class.relkind = 'r'
       and attribute.attname = 'workspace_id' and not attribute.attisdropped
       and not table_class.relname = any($1::text[])
     order by 1`,
    [PURGE_PRESERVED_TABLES],
  );
  for (const { name } of tables.rows) {
    const left = await client.query(
      `select 1 from app.${name} where workspace_id = $1 limit 1`,
      [workspaceId],
    );
    if (left.rowCount !== 0)
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
    const workspace = candidateSchema.parse(candidate);
    if (workspace.status === 'pending_deletion') {
      await client.query(
        `update app.workspaces set status = 'purging', updated_at = clock_timestamp()
           where id = $1`,
        [workspace.id],
      );
      return { status: 'started' as const, workspaceId: workspace.id };
    }
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspace.id,
    ]);
    for (const step of PURGE_STEPS) {
      const changed =
        'run' in step
          ? await step.run(client, workspace.id, options.pageSize)
          : ((
              await client.query(step.statement, [
                workspace.id,
                options.pageSize,
              ])
            ).rowCount ?? 0);
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
    const locked = await client.query(
      `select 1 from app.workspaces where id = $1 and status = 'purging'
         for update skip locked`,
      [workspaceId],
    );
    // Another worker is on it, or already finished it.
    if (locked.rowCount !== 1) return { status: 'idle' as const };
    await assertNothingLeft(client, workspaceId);
    await client.query(
      `update app.workspaces
         set status = 'deleted', name = 'Deleted workspace',
             slug = 'deleted-' || id::text, created_by = null,
             deletion_requested_by = null, deletion_reason = 'purged',
             updated_at = clock_timestamp()
         where id = $1`,
      [workspaceId],
    );
    return { status: 'completed' as const, workspaceId };
  });
}
