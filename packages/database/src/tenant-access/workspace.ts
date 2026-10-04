import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { destroyCanceledPoolClient } from '../platform/pool-client-disposal.js';
import { acquireAbortablePoolClient } from '../platform/abortable-pool-checkout.js';
import { databaseSchema } from '../schema.js';
import { NativeTenantRead } from './native-tenant-read.js';

const workspaceIdSchema = z.uuid();
const actorIdSchema = z.uuid();

export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' };
export type WorkspaceDrizzle = NodePgDatabase<typeof databaseSchema>;

export type WorkspaceTransaction = Readonly<{
  db: WorkspaceDrizzle;
  workspaceId: WorkspaceId;
}>;

/**
 * Adapt an already tenant-scoped transaction without owning its lifecycle.
 * The caller must have established this workspace on this exact client; this
 * adapter does not begin, commit, roll back, change scope or release it.
 * Keep internal: possession of a workspace identifier is not tenant authority.
 */
export function workspaceTransactionFromClient(
  client: PoolClient,
  workspaceId: WorkspaceId,
): WorkspaceTransaction {
  const db = drizzle(client, { schema: databaseSchema });
  return Object.freeze({ db, workspaceId });
}

export type WorkspaceTransactionOptions = Readonly<{
  signal?: AbortSignal;
  statementTimeoutMillis?: number;
  /** Native-only operation/cleanup contract; ordinary transaction mode is unchanged. */
  nativeReadBudget?: Readonly<{
    readTimeoutMillis: number;
    controlReadTimeoutMillis: number;
  }>;
}>;

export type TenantTransactionScope = Readonly<{
  workspaceId: string;
  actorId?: string;
}>;

type ActorTransactionScope = Readonly<{
  actorId: string;
  workspaceId?: undefined;
  discoveryScope: 'workspace_memberships';
}>;

type TransactionScope = TenantTransactionScope | ActorTransactionScope;

export function parseWorkspaceId(value: string): WorkspaceId {
  return workspaceIdSchema.parse(value) as WorkspaceId;
}

async function assertNoTenantContext(client: PoolClient): Promise<void> {
  const result = await client.query<{
    workspace_id: string | null;
    actor_id: string | null;
    discovery_scope: string | null;
  }>(
    `select current_setting('app.workspace_id', true) as workspace_id,
            current_setting('app.actor_id', true) as actor_id,
            current_setting('app.discovery_scope', true) as discovery_scope`,
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
  if (
    row?.discovery_scope !== undefined &&
    row.discovery_scope !== null &&
    row.discovery_scope !== ''
  ) {
    throw new Error('Pooled PostgreSQL client retained discovery context');
  }
}

async function verifyTenantContext(
  client: PoolClient,
  scope: TransactionScope,
  statementTimeoutMillis: number | undefined,
): Promise<void> {
  const result = await client.query<{
    workspace_id: string | null;
    actor_id: string | null;
    discovery_scope?: string | null;
    statement_timeout_millis: string | number;
  }>(
    `select current_setting('app.workspace_id', true) as workspace_id,
            current_setting('app.actor_id', true) as actor_id,
            current_setting('app.discovery_scope', true) as discovery_scope,
            (select setting::bigint from pg_settings where name='statement_timeout')
              as statement_timeout_millis`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('PostgreSQL tenant context verification failed');
  }
  const expectedWorkspaceId = scope.workspaceId ?? null;
  const actualWorkspaceId = row.workspace_id === '' ? null : row.workspace_id;
  if (actualWorkspaceId !== expectedWorkspaceId) {
    throw new Error('PostgreSQL tenant context verification failed');
  }
  if (scope.actorId !== undefined && row.actor_id !== scope.actorId) {
    throw new Error('PostgreSQL tenant context verification failed');
  }
  const expectedDiscoveryScope =
    'discoveryScope' in scope ? scope.discoveryScope : null;
  const actualDiscoveryScope =
    row.discovery_scope === undefined || row.discovery_scope === ''
      ? null
      : row.discovery_scope;
  if (actualDiscoveryScope !== expectedDiscoveryScope) {
    throw new Error('PostgreSQL tenant context verification failed');
  }
  if (
    statementTimeoutMillis !== undefined &&
    Number(row.statement_timeout_millis) !== statementTimeoutMillis
  ) {
    throw new Error('PostgreSQL transaction timeout verification failed');
  }
}

function parseStatementTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError('Invalid PostgreSQL statement timeout');
  }
  return value;
}

async function runTransaction<T>(
  pool: Pool,
  scope: TransactionScope | undefined,
  operation: (client: PoolClient) => Promise<T>,
  options: WorkspaceTransactionOptions,
  mode: 'read_write' | 'repeatable_read_only',
  messages: Readonly<{
    abort: string;
    rollback: string;
    cleanup: string;
  }>,
): Promise<T> {
  let statementTimeoutMillis = parseStatementTimeout(
    options.statementTimeoutMillis,
  );
  const nativeBudget = options.nativeReadBudget;
  if (nativeBudget !== undefined && mode !== 'repeatable_read_only')
    throw new TypeError(
      'Native read budget cannot authorize a write transaction',
    );
  const abortError = new Error(messages.abort);
  abortError.name = 'AbortError';
  if (options.signal?.aborted) throw abortError;
  const nativeRead =
    nativeBudget === undefined
      ? undefined
      : new NativeTenantRead(pool, options.signal, nativeBudget, abortError);
  const signal = nativeRead?.signal ?? options.signal;

  let client: PoolClient;
  try {
    client =
      nativeRead === undefined
        ? await acquireAbortablePoolClient(
            pool,
            signal,
            () => abortError,
            (lateClient) => {
              lateClient.release(abortError);
            },
          )
        : await nativeRead.acquire();
  } catch (error: unknown) {
    await nativeRead?.finish({ error });
    throw error;
  }
  let transactionOpen = false;
  let clientReleased = false;
  const isReleased = (): boolean => clientReleased;

  const releaseForAbort = (): void => {
    if (clientReleased) return;
    clientReleased = true;
    // A pool error release removes the client; the shared helper also sends a
    // CancelRequest because PostgreSQL may otherwise finish a sleeping or
    // blocked statement after its application socket disappears.
    try {
      if (nativeRead === undefined)
        destroyCanceledPoolClient(client, abortError);
      else nativeRead.dispose(client);
    } catch {
      // The caller's abort remains authoritative even if pool bookkeeping
      // itself fails after the socket has been terminated.
    }
  };
  const destroyClient = (): void => {
    if (clientReleased) return;
    clientReleased = true;
    if (nativeRead === undefined) client.release(true);
    else nativeRead.dispose(client);
  };
  const assertNotAborted = (): void => {
    nativeRead?.remainingMillis();
    if (signal?.aborted) throw abortError;
  };

  if (signal?.aborted) {
    releaseForAbort();
    await nativeRead?.finish({ error: abortError });
    throw abortError;
  }
  signal?.addEventListener('abort', releaseForAbort, { once: true });

  let failure: Readonly<{ error: unknown }> | undefined;
  try {
    assertNotAborted();
    await assertNoTenantContext(client);
    assertNotAborted();
    await client.query(
      mode === 'repeatable_read_only'
        ? 'begin isolation level repeatable read read only'
        : 'begin',
    );
    transactionOpen = true;
    assertNotAborted();
    if (scope === undefined) {
      // Platform-global transactions deliberately install no tenant context.
    } else if (scope.workspaceId === undefined) {
      await client.query(
        `select set_config('app.actor_id', $1, true),
                set_config('app.discovery_scope', $2, true)`,
        [scope.actorId, scope.discoveryScope],
      );
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
    assertNotAborted();
    if (nativeRead !== undefined)
      statementTimeoutMillis = Math.min(
        statementTimeoutMillis ?? Infinity,
        nativeRead.remainingMillis(),
      );
    if (statementTimeoutMillis !== undefined) {
      await client.query("select set_config('statement_timeout', $1, true)", [
        `${String(statementTimeoutMillis)}ms`,
      ]);
    }
    assertNotAborted();
    if (scope !== undefined) {
      await verifyTenantContext(client, scope, statementTimeoutMillis);
      assertNotAborted();
    }

    const result = await operation(client);
    assertNotAborted();
    await client.query('commit');
    transactionOpen = false;
    assertNotAborted();
    await assertNoTenantContext(client);
    if (nativeRead !== undefined) assertNotAborted();
    clientReleased = true;
    client.release();
    return result;
  } catch (error: unknown) {
    const canceled =
      signal?.aborted === true &&
      (nativeRead === undefined ||
        error === abortError ||
        (error instanceof Error &&
          (error.name === 'AbortError' ||
            [
              'Connection terminated',
              'Connection terminated unexpectedly',
            ].includes(error.message))));
    failure = { error: canceled ? abortError : error };
    if (canceled) throw abortError;
    if (clientReleased || nativeRead?.isStopped() === true) throw error;
    if (transactionOpen) {
      try {
        await client.query('rollback');
      } catch (rollbackError: unknown) {
        const combined = new AggregateError(
          [error, rollbackError],
          messages.rollback,
        );
        failure = { error: combined };
        destroyClient();
        if (nativeRead === undefined && signal?.aborted) throw abortError;
        throw combined;
      }
    }

    if (nativeRead !== undefined && (nativeRead.isStopped() || isReleased()))
      throw error;
    try {
      await assertNoTenantContext(client);
      if (
        nativeRead === undefined ||
        (!nativeRead.isStopped() && !isReleased())
      ) {
        clientReleased = true;
        client.release();
      }
    } catch (cleanupError: unknown) {
      const combined = new AggregateError(
        [error, cleanupError],
        messages.cleanup,
      );
      failure = { error: combined };
      destroyClient();
      if (nativeRead === undefined && signal?.aborted) throw abortError;
      throw combined;
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', releaseForAbort);
    await nativeRead?.finish(failure);
  }
}

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
  return runTransaction(pool, scope, operation, options, 'read_write', {
    abort: 'Workspace transaction aborted',
    cleanup: 'Tenant context cleanup failed',
    rollback: 'Tenant-scoped transaction rollback failed',
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
    operation,
    options,
    'repeatable_read_only',
    {
      abort: 'Actor-scoped transaction aborted',
      cleanup: 'Actor context cleanup failed',
      rollback: 'Actor-scoped transaction rollback failed',
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
    (client) => operation(workspaceTransactionFromClient(client, workspaceId)),
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
    (client) => operation(workspaceTransactionFromClient(client, workspaceId)),
    options,
  );
}
