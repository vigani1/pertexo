import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { databaseSchema } from './schema.js';

const workspaceIdSchema = z.uuid();

export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' };
export type WorkspaceDrizzle = NodePgDatabase<typeof databaseSchema>;

export type WorkspaceTransaction = Readonly<{
  db: WorkspaceDrizzle;
  workspaceId: WorkspaceId;
}>;

export type WorkspaceTransactionOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type TenantTransactionScope = Readonly<{
  workspaceId: string;
  actorId?: string;
}>;

export function parseWorkspaceId(value: string): WorkspaceId {
  return workspaceIdSchema.parse(value) as WorkspaceId;
}

async function assertNoTenantContext(client: PoolClient): Promise<void> {
  const result = await client.query<{
    workspace_id: string | null;
    actor_id: string | null;
  }>(
    "select current_setting('app.workspace_id', true) as workspace_id, current_setting('app.actor_id', true) as actor_id",
  );
  const row = result.rows[0];
  if (
    row?.workspace_id !== undefined &&
    row.workspace_id !== null &&
    row.workspace_id !== ''
  ) {
    throw new Error('Pooled PostgreSQL client retained workspace context');
  }
  if (
    row?.actor_id !== undefined &&
    row.actor_id !== null &&
    row.actor_id !== ''
  ) {
    throw new Error('Pooled PostgreSQL client retained actor context');
  }
}

async function verifyTenantContext(
  client: PoolClient,
  scope: TenantTransactionScope,
): Promise<void> {
  const result = await client.query<{
    workspace_id: string | null;
    actor_id: string | null;
  }>(
    "select current_setting('app.workspace_id', true) as workspace_id, current_setting('app.actor_id', true) as actor_id",
  );
  const row = result.rows[0];
  if (row?.workspace_id !== scope.workspaceId) {
    throw new Error('PostgreSQL tenant context verification failed');
  }
  if (scope.actorId !== undefined && row.actor_id !== scope.actorId) {
    throw new Error('PostgreSQL tenant context verification failed');
  }
}

async function runTransaction<T>(
  pool: Pool,
  scope: TenantTransactionScope | undefined,
  operation: (client: PoolClient) => Promise<T>,
  options: WorkspaceTransactionOptions,
  mode: 'read_write' | 'repeatable_read_only',
  messages: Readonly<{
    abort: string;
    rollback: string;
    cleanup: string;
  }>,
): Promise<T> {
  const abortError = new Error(messages.abort);
  abortError.name = 'AbortError';
  if (options.signal?.aborted) throw abortError;

  const client = await acquirePoolClient(pool, options.signal, abortError);
  let transactionOpen = false;
  let clientReleased = false;

  const releaseForAbort = (): void => {
    if (clientReleased) return;
    clientReleased = true;
    // PoolClient.release(error) removes the connection from the pool and
    // force-closes an active query. This is the only reliable cancellation
    // seam available to node-postgres for a query already on the wire.
    client.release(abortError);
  };
  const destroyClient = (): void => {
    if (clientReleased) return;
    clientReleased = true;
    client.release(true);
  };

  if (options.signal?.aborted) {
    releaseForAbort();
    throw abortError;
  }
  options.signal?.addEventListener('abort', releaseForAbort, { once: true });

  try {
    await assertNoTenantContext(client);
    await client.query(
      mode === 'repeatable_read_only'
        ? 'begin isolation level repeatable read read only'
        : 'begin',
    );
    transactionOpen = true;
    if (scope === undefined) {
      // Platform-global transactions deliberately install no tenant context.
    } else if (scope.actorId === undefined) {
      await client.query("select set_config('app.workspace_id', $1, true)", [
        scope.workspaceId,
      ]);
    } else {
      await client.query(
        "select set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true)",
        [scope.workspaceId, scope.actorId],
      );
    }
    if (scope !== undefined) await verifyTenantContext(client, scope);

    const result = await operation(client);
    await client.query('commit');
    transactionOpen = false;
    await assertNoTenantContext(client);
    clientReleased = true;
    client.release();
    return result;
  } catch (error: unknown) {
    if (options.signal?.aborted) throw abortError;
    if (clientReleased) throw error;
    if (transactionOpen) {
      try {
        await client.query('rollback');
      } catch (rollbackError: unknown) {
        destroyClient();
        if (options.signal?.aborted) throw abortError;
        throw new AggregateError([error, rollbackError], messages.rollback);
      }
    }

    try {
      await assertNoTenantContext(client);
      clientReleased = true;
      client.release();
    } catch (cleanupError: unknown) {
      destroyClient();
      if (options.signal?.aborted) throw abortError;
      throw new AggregateError([error, cleanupError], messages.cleanup);
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', releaseForAbort);
  }
}

async function acquirePoolClient(
  pool: Pool,
  signal: AbortSignal | undefined,
  abortError: Error,
): Promise<PoolClient> {
  const connection = pool.connect();
  if (signal === undefined) return connection;

  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort?.(abortError);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) throw abortError;
    return await Promise.race([connection, aborted]);
  } catch (error: unknown) {
    if (signal.aborted) {
      void connection.then(
        (client) => {
          client.release(abortError);
        },
        () => undefined,
      );
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Runs one workspace-scoped transaction on a single checked-out pool client
 * with fail-closed hygiene: absent-context proof before use, read-back
 * verification of every configured setting, wire-level cancellation through
 * the abort signal, and client destruction whenever transaction rollback or
 * context cleanup fails so a contaminated client can never be reused.
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
  return runTransaction(pool, scope, operation, options, 'read_write', {
    abort: 'Workspace transaction aborted',
    cleanup: 'Tenant context cleanup failed',
    rollback: 'Tenant-scoped transaction rollback failed',
  });
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
  return runTransaction(
    pool,
    scope,
    operation,
    options,
    'repeatable_read_only',
    {
      abort: 'Workspace transaction aborted',
      cleanup: 'Tenant context cleanup failed',
      rollback: 'Tenant-scoped transaction rollback failed',
    },
  );
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
  return runTransaction(pool, undefined, operation, options, 'read_write', {
    abort: 'Platform transaction aborted',
    cleanup: 'Platform context cleanup failed',
    rollback: 'Platform transaction rollback failed',
  });
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
