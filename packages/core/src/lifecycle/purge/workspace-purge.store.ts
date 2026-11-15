import { withArtifactErasure } from '../artifacts/backup-deletion-lock.repository.js';
import type { z } from 'zod';
import { claimPurgeWorkspace } from './directory.repository.js';

import type { Pool, PoolClient } from 'pg';

import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { acquireDatabasePool } from '@pertexo/database/platform';
import {
  inRetentionTransaction,
  withDeadline,
} from '../retention/transaction.js';
import { scopeToWorkspace } from '../retention/transaction-settings.repository.js';
import {
  deleteWorkspaceMemberships,
  hasWorkspaceRows,
  leaveWorkspaceTombstone,
  listWorkspaceTables,
  lockPurgingWorkspace,
  markWorkspacePurging,
} from './workspace-state.repository.js';
import type {
  WorkspacePurgeObjectStore,
  WorkspacePurgeProcessResult,
} from './workspace-purge.types.js';
import {
  optionsSchema,
  type WorkspacePurgeOptions,
} from './workspace-purge-options.schemas.js';
import { PURGE_STEPS } from './steps.js';

export type WorkspacePurgeCoordinator = ReturnType<
  typeof createWorkspacePurgeCoordinator
>;

/**
 * Purges workspaces whose recovery period has ended. Each call does one
 * bounded unit of work for one workspace: it starts a purge, removes one
 * page of rows or stored objects, or finishes the purge by leaving a
 * tombstone. Any number of workers can call it; each takes a different
 * workspace while it changes rows. No member is acting, so this stays off
 * `withWorkspaceAccess`: it runs on the maintenance role.
 */
export function createWorkspacePurgeCoordinator(
  config: DatabaseConfig,
  objectStore: WorkspacePurgeObjectStore,
  inputOptions: WorkspacePurgeOptions = {},
  runtime?: DatabaseRuntime,
) {
  const options = optionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;
  return Object.freeze({
    close: () => lease.close(),
    processNext: async (
      signal?: AbortSignal,
    ): Promise<WorkspacePurgeProcessResult> => {
      const rows = await purgeRows({ pool, options }, signal);
      if (!('rowsPurged' in rows)) return rows;
      const workspaceId = rows.rowsPurged;
      // Stored objects go after rows and outside any transaction.
      const objects = await withArtifactErasure(pool, () =>
        objectStore.purgeWorkspacePage({
          maxObjects: options.objectPageSize,
          signal: withDeadline(signal, options.objectTimeoutMs),
          workspaceId,
        }),
      );
      if (!objects?.completed)
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
      await markWorkspacePurging(client, workspace.id);
      return { status: 'started' as const, workspaceId: workspace.id };
    }
    await scopeToWorkspace(client, workspace.id);
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
    // Another worker owns it, or has finished it.
    if (!(await lockPurgingWorkspace(client, workspaceId)))
      return { status: 'idle' as const };
    await scopeToWorkspace(client, workspaceId);
    await deleteWorkspaceMemberships(client, workspaceId);
    await assertNothingLeft(client, workspaceId);
    await leaveWorkspaceTombstone(client, workspaceId);
    return { status: 'completed' as const, workspaceId };
  });
}

/** Fails if a workspace table still holds the purged workspace's rows. */
async function assertNothingLeft(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  // Discover every live relation so an unlisted table can never pass completion.
  for (const name of await listWorkspaceTables(client))
    if (await hasWorkspaceRows(client, name, workspaceId))
      throw new Error(`Workspace purge left rows in ${name}`);
}
