import { drizzle } from 'drizzle-orm/node-postgres';

import type { Pool, PoolClient } from 'pg';

import { databaseSchema } from '../schema.js';
import { actorIdSchema } from './transactions/input.js';
import type {
  WorkspaceTransaction,
  WorkspaceTransactionOptions,
  TenantTransactionScope,
  TransactionScope,
  WorkspaceScopeRunner,
} from './transactions/contract.js';
import {
  parseWorkspaceId,
  installTransactionScope,
  assertNoTenantContext,
  verifyTenantContext,
} from './transactions/scope.js';
import { runTransaction } from './transactions/run.js';

export {
  type WorkspaceId,
  type WorkspaceDrizzle,
  type WorkspaceTransaction,
  type WorkspaceTransactionOptions,
  type TenantTransactionScope,
  type WorkspaceScopeRunner,
} from './transactions/contract.js';
export { parseWorkspaceId } from './transactions/scope.js';
/**
 * Runs one workspace-scoped transaction on a single checked-out pool client
 * with fail-closed hygiene: absent-context proof before use, read-back
 * verification of every configured setting, wire-level cancellation through
 * the abort signal, and client destruction whenever transaction rollback or
 * context cleanup fails so a contaminated client can never be reused. The
 * callback owns its non-SQL work and must not retain or use the client after it
 * settles; abort can destroy that client while callback work is still pending.
 */
export async function withTenantScopedClient<T>(
  pool: Pool,
  scopeInput: TenantTransactionScope,
  operation: (client: PoolClient) => Promise<T>,
  options: WorkspaceTransactionOptions = {},
): Promise<T> {
  const scope: TenantTransactionScope = {
    ...scopeInput,
    workspaceId: parseWorkspaceId(scopeInput.workspaceId),
  };
  return runTransaction(pool, scope, {
    operation,
    options,
    mode: 'read_write',
    messages: {
      abort: 'Workspace transaction aborted',
      cleanup: 'Tenant context cleanup failed',
      rollback: 'Tenant-scoped transaction rollback failed',
    },
  });
}

/**
 * Runs an actor-scoped transaction for bounded cross-workspace discovery.
 * No workspace context is installed, so tenant policies must explicitly opt
 * into actor-scoped reads and constrain every returned row to that actor.
 */
export async function withActorScopedClient<T>(
  pool: Pool,
  actorIdInput: string,
  operation: (client: PoolClient) => Promise<T>,
  options: WorkspaceTransactionOptions = {},
): Promise<T> {
  const actorId = actorIdSchema.parse(actorIdInput);
  return runTransaction(
    pool,
    { actorId, discoveryScope: 'workspace_memberships' },
    {
      operation,
      options,
      mode: 'repeatable_read_only',
      messages: {
        abort: 'Actor-scoped transaction aborted',
        cleanup: 'Actor context cleanup failed',
        rollback: 'Actor-scoped transaction rollback failed',
      },
    },
  );
}

/** Internal worker seam for stable repeatable-read snapshots. */
export async function withTenantScopedReadClient<T>(
  pool: Pool,
  scopeInput: TenantTransactionScope,
  operation: (client: PoolClient) => Promise<T>,
  options: WorkspaceTransactionOptions = {},
): Promise<T> {
  const scope: TenantTransactionScope = {
    ...scopeInput,
    workspaceId: parseWorkspaceId(scopeInput.workspaceId),
  };
  return runTransaction(pool, scope, {
    operation,
    options,
    mode: 'repeatable_read_only',
    messages: {
      abort: 'Workspace transaction aborted',
      cleanup: 'Tenant context cleanup failed',
      rollback: 'Tenant-scoped transaction rollback failed',
    },
  });
}

/**
 * Runs a platform-global transaction without installing tenant context while
 * retaining the same abort, rollback, and pooled-client hygiene guarantees as
 * tenant-scoped work. This path is intentionally explicit: callers may use it
 * only for data whose authority is global rather than workspace-owned.
 */
export async function withPlatformTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
  options: WorkspaceTransactionOptions = {},
): Promise<T> {
  return runTransaction(pool, undefined, {
    operation,
    options,
    mode: 'read_write',
    messages: {
      abort: 'Platform transaction aborted',
      cleanup: 'Platform context cleanup failed',
      rollback: 'Platform transaction rollback failed',
    },
  });
}

/** A cross-workspace command gets a client only while its explicit workspace fence is installed. */
export function withMultiWorkspaceTransaction<T>(
  pool: Pool,
  operation: (inWorkspace: WorkspaceScopeRunner) => Promise<T>,
  options: WorkspaceTransactionOptions = {},
): Promise<T> {
  return runTransaction(pool, undefined, {
    operation: (client) =>
      operation((scope, scopedOperation) =>
        withWorkspaceScope(client, scope, scopedOperation),
      ),
    options,
    mode: 'read_write',
    messages: {
      abort: 'Multi-workspace transaction aborted',
      cleanup: 'Multi-workspace context cleanup failed',
      rollback: 'Multi-workspace transaction rollback failed',
    },
  });
}

/** Installs one fence inside an outer transaction, restoring no-context hygiene between scopes. */
async function withInstalledScope<T>(
  client: PoolClient,
  scope: TransactionScope,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  await assertNoTenantContext(client);
  const clear = async () => {
    await client.query(`select set_config('app.workspace_id','',true),
      set_config('app.actor_id','',true),set_config('app.discovery_scope','',true)`);
    await assertNoTenantContext(client);
  };
  await installTransactionScope(client, scope);
  await verifyTenantContext(client, scope, undefined);
  let result: T;
  try {
    result = await operation(client);
  } catch (error: unknown) {
    try {
      await clear();
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        'Transaction scope cleanup failed',
      );
    }
    throw error;
  }
  await clear();
  return result;
}

export function withWorkspaceScope<T>(
  client: PoolClient,
  scope: TenantTransactionScope,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withInstalledScope(
    client,
    { ...scope, workspaceId: parseWorkspaceId(scope.workspaceId) },
    operation,
  );
}

/** Reads only the current actor's active memberships through the existing discovery policy. */
export function withActorDiscoveryScope<T>(
  client: PoolClient,
  actorId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withInstalledScope(
    client,
    {
      actorId: actorIdSchema.parse(actorId),
      discoveryScope: 'workspace_memberships',
    },
    operation,
  );
}

export async function withWorkspaceTransaction<T>(
  pool: Pool,
  workspaceIdInput: string,
  operation: (transaction: WorkspaceTransaction) => Promise<T>,
  options: WorkspaceTransactionOptions = {},
): Promise<T> {
  const workspaceId = parseWorkspaceId(workspaceIdInput);
  return withTenantScopedClient(
    pool,
    { workspaceId },
    async (client) => {
      const db = drizzle(client, { schema: databaseSchema });
      return operation(Object.freeze({ db, workspaceId }));
    },
    options,
  );
}

/** Runs a workspace-scoped read in one stable repeatable-read snapshot. */
export async function withWorkspaceReadTransaction<T>(
  pool: Pool,
  workspaceIdInput: string,
  operation: (transaction: WorkspaceTransaction) => Promise<T>,
  options: WorkspaceTransactionOptions = {},
): Promise<T> {
  const workspaceId = parseWorkspaceId(workspaceIdInput);
  return withTenantScopedReadClient(
    pool,
    { workspaceId },
    async (client) => {
      const db = drizzle(client, { schema: databaseSchema });
      return operation(Object.freeze({ db, workspaceId }));
    },
    options,
  );
}
