import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { withPlatformTransaction } from '../tenant-access/workspace.js';
import { sha256HexSchema } from '../validation/persisted-primitives.js';

export type RetentionTransactionOptions = Readonly<{
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}>;

const WORKSPACE_DESTRUCTIVE_LOCK_SALT = 1_934_781_127;

function throwableError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error });
}

interface DestructiveLockPool extends Pick<Pool, 'connect'> {
  readonly options: Readonly<{ max: number }>;
}

interface LockPermitWaiter {
  aborted: boolean;
  onAbort?: () => void;
  readonly resolve: () => void;
  readonly signal?: AbortSignal;
}

interface LockPermitState {
  active: number;
  readonly capacity: number;
  readonly waiters: LockPermitWaiter[];
}

const lockPermitStates = new WeakMap<object, LockPermitState>();

function acquireDestructiveLockClient(
  pool: DestructiveLockPool,
  signal?: AbortSignal,
): Promise<PoolClient> {
  signal?.throwIfAborted();
  const pendingClient = pool.connect();
  if (signal === undefined) return pendingClient;

  return new Promise<PoolClient>((resolve, reject) => {
    let settled = false;
    const settle = (completion: () => void): boolean => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      completion();
      return true;
    };
    const onAbort = (): void => {
      settle(() => {
        reject(
          throwableError(signal.reason, 'Workspace lifecycle lock aborted'),
        );
      });
    };

    pendingClient.then(
      (client) => {
        if (
          !settle(() => {
            resolve(client);
          })
        )
          client.release();
      },
      (error: unknown) => {
        settle(() => {
          reject(
            throwableError(
              error,
              'Workspace lifecycle pool acquisition failed',
            ),
          );
        });
      },
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function acquireDestructiveLockPermit(
  pool: DestructiveLockPool,
  signal?: AbortSignal,
): Promise<() => void> {
  signal?.throwIfAborted();
  const maximum = pool.options.max;
  if (!Number.isSafeInteger(maximum) || maximum < 2)
    throw new RangeError(
      'Workspace lifecycle coordination requires a database pool of at least 2 connections',
    );
  const existing = lockPermitStates.get(pool);
  const state = existing ?? {
    active: 0,
    capacity: maximum - 1,
    waiters: [],
  };
  if (existing === undefined) lockPermitStates.set(pool, state);
  if (state.active < state.capacity) state.active += 1;
  else {
    await new Promise<void>((resolve, reject) => {
      const waiter: LockPermitWaiter = {
        aborted: false,
        resolve,
        ...(signal === undefined ? {} : { signal }),
      };
      if (signal !== undefined) {
        const onAbort = (): void => {
          waiter.aborted = true;
          reject(
            throwableError(signal.reason, 'Workspace lifecycle lock aborted'),
          );
        };
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      state.waiters.push(waiter);
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (;;) {
      const waiter = state.waiters.shift();
      if (waiter === undefined) {
        state.active -= 1;
        return;
      }
      if (waiter.signal !== undefined && waiter.onAbort !== undefined)
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.aborted) continue;
      waiter.resolve();
      return;
    }
  };
}

export async function acquireWorkspaceDestructiveOperationLock(
  client: PoolClient,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<void> {
  await client.query({
    text: 'select pg_advisory_lock(hashtextextended($1,$2))',
    values: [workspaceId, WORKSPACE_DESTRUCTIVE_LOCK_SALT],
    ...(signal === undefined ? {} : { signal }),
  });
}

export async function releaseWorkspaceDestructiveOperationLock(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  const unlocked = await client.query<{ unlocked: boolean }>({
    text: 'select pg_advisory_unlock(hashtextextended($1,$2)) unlocked',
    values: [workspaceId, WORKSPACE_DESTRUCTIVE_LOCK_SALT],
  });
  if (unlocked.rows[0]?.unlocked !== true)
    throw new Error('Workspace destructive-operation lock was lost');
}

/**
 * Serializes external destructive work with control-ledger projection without
 * keeping a PostgreSQL transaction open across object-store I/O.
 */
export async function withWorkspaceDestructiveOperationLock<T>(
  pool: DestructiveLockPool,
  workspaceId: string,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const releasePermit = await acquireDestructiveLockPermit(pool, signal);
  let client: PoolClient;
  try {
    client = await acquireDestructiveLockClient(pool, signal);
  } catch (error: unknown) {
    releasePermit();
    throw error;
  }
  let acquired = false;
  const clientState = { released: false };
  let operationError: unknown;
  let result: T | undefined;
  const releaseLockWaitForAbort = (): void => {
    if (clientState.released) return;
    clientState.released = true;
    // node-postgres does not reliably cancel an already-sent lock query from
    // QueryConfig.signal. Destroying the checked-out connection terminates its
    // PostgreSQL backend, releases any concurrently granted session lock, and
    // keeps a cancelled waiter from occupying pool capacity.
    client.release(
      throwableError(signal?.reason, 'Workspace lifecycle lock aborted'),
    );
  };
  signal?.addEventListener('abort', releaseLockWaitForAbort, { once: true });
  if (signal?.aborted === true) releaseLockWaitForAbort();
  try {
    signal?.throwIfAborted();
    await acquireWorkspaceDestructiveOperationLock(client, workspaceId, signal);
    signal?.removeEventListener('abort', releaseLockWaitForAbort);
    signal?.throwIfAborted();
    acquired = true;
    // PostgreSQL may grant a lock concurrently with cancellation. Re-check
    // after the awaited acquisition before destructive work can begin.
    signal?.throwIfAborted();
    result = await work();
  } catch (error: unknown) {
    operationError =
      signal?.aborted === true
        ? throwableError(signal.reason, 'Workspace lifecycle lock aborted')
        : error;
  } finally {
    signal?.removeEventListener('abort', releaseLockWaitForAbort);
  }

  let unlockError: unknown;
  if (acquired) {
    try {
      await releaseWorkspaceDestructiveOperationLock(client, workspaceId);
    } catch (error: unknown) {
      unlockError = error;
    }
  }
  try {
    if (!clientState.released)
      client.release(
        unlockError instanceof Error
          ? unlockError
          : unlockError === undefined
            ? undefined
            : new Error('Workspace destructive-operation lock release failed'),
      );
  } finally {
    releasePermit();
  }
  if (operationError !== undefined && unlockError === undefined)
    throw throwableError(
      operationError,
      'Workspace destructive operation failed',
    );
  if (operationError === undefined && unlockError !== undefined)
    throw throwableError(
      unlockError,
      'Workspace destructive-operation lock release failed',
    );
  if (operationError !== undefined && unlockError !== undefined)
    throw new AggregateError(
      [operationError, unlockError],
      'Workspace destructive operation did not complete cleanly',
    );
  return result as T;
}

function parseLockedRetentionControl(
  row: Readonly<{
    retention_control_hash: string;
    retention_control_sequence: number | string;
  }>,
): Readonly<{ hash: string; sequence: number }> {
  return Object.freeze({
    hash: sha256HexSchema.parse(row.retention_control_hash),
    sequence: z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(row.retention_control_sequence),
  });
}

export async function lockWorkspaceRetentionControl(
  pool: Pool,
  options: RetentionTransactionOptions,
  signal: AbortSignal | undefined,
  workspaceId: string,
  missingRowMessage: string,
): Promise<Readonly<{ hash: string; sequence: number }>> {
  return inRetentionTransaction(pool, options, signal, async (client) => {
    const locked = await client.query<{
      retention_control_hash: string;
      retention_control_sequence: number | string;
    }>({
      text: 'select * from app.lock_workspace_control_ledger($1)',
      values: [workspaceId],
    });
    const row = locked.rows[0];
    if (row === undefined) throw new Error(missingRowMessage);
    return parseLockedRetentionControl(row);
  });
}

export async function inRetentionTransaction<T>(
  pool: Pool,
  options: RetentionTransactionOptions,
  signal: AbortSignal | undefined,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (
    !Number.isSafeInteger(options.lockTimeoutMs) ||
    options.lockTimeoutMs < 1 ||
    options.lockTimeoutMs > 2_147_483_647
  ) {
    throw new RangeError('Invalid PostgreSQL lock timeout');
  }
  try {
    return await withPlatformTransaction(
      pool,
      async (client) => {
        await client.query("select set_config('lock_timeout', $1, true)", [
          `${String(options.lockTimeoutMs)}ms`,
        ]);
        const result = await work(client);
        signal?.throwIfAborted();
        return result;
      },
      {
        ...(signal === undefined ? {} : { signal }),
        statementTimeoutMillis: options.statementTimeoutMs,
      },
    );
  } catch (error: unknown) {
    // Maintenance runners distinguish their exact lease-loss/shutdown reason.
    // The shared guard owns wire cancellation and destroys the affected client.
    signal?.throwIfAborted();
    throw error;
  }
}
