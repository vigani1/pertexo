import type { Pool, PoolClient } from 'pg';

import { destroyCanceledPoolClient } from '../../platform/pool/client-disposal.js';
import { acquireAbortablePoolClient } from '../../platform/pool/abortable-checkout.js';

import type {
  WorkspaceTransactionOptions,
  TransactionScope,
} from './contract.js';
import {
  installTransactionScope,
  assertNoTenantContext,
  verifyTenantContext,
  parseStatementTimeout,
} from './scope.js';

export async function runTransaction<T>(
  pool: Pool,
  scope: TransactionScope | undefined,
  {
    operation,
    options,
    mode,
    messages,
  }: Readonly<{
    operation: (client: PoolClient) => Promise<T>;
    options: WorkspaceTransactionOptions;
    mode: 'read_write' | 'repeatable_read_only';
    messages: Readonly<{
      abort: string;
      rollback: string;
      cleanup: string;
    }>;
  }>,
): Promise<T> {
  const statementTimeoutMillis = parseStatementTimeout(
    options.statementTimeoutMillis,
  );
  const abortError = new Error(messages.abort);
  abortError.name = 'AbortError';
  if (options.signal?.aborted) throw abortError;

  const client = await acquireAbortablePoolClient(
    pool,
    options.signal,
    () => abortError,
    (lateClient) => {
      lateClient.release(abortError);
    },
  );
  let transactionOpen = false;
  let clientReleased = false;

  const releaseForAbort = (): void => {
    if (clientReleased) return;
    clientReleased = true;
    // A pool error release removes the client; the shared helper also sends a
    // CancelRequest because PostgreSQL may otherwise finish a sleeping or
    // blocked statement after its application socket disappears.
    try {
      destroyCanceledPoolClient(client, abortError);
    } catch {
      // The caller's abort remains authoritative even if pool bookkeeping
      // itself fails after the socket has been terminated.
    }
  };
  const destroyClient = (): void => {
    if (clientReleased) return;
    clientReleased = true;
    client.release(true);
  };
  const assertNotAborted = (): void => {
    if (options.signal?.aborted) throw abortError;
  };

  if (options.signal?.aborted) {
    releaseForAbort();
    throw abortError;
  }
  options.signal?.addEventListener('abort', releaseForAbort, { once: true });

  try {
    await assertNoTenantContext(client);
    assertNotAborted();
    await client.query(
      mode === 'repeatable_read_only'
        ? 'begin isolation level repeatable read read only'
        : 'begin',
    );
    transactionOpen = true;
    assertNotAborted();
    await installTransactionScope(client, scope);
    assertNotAborted();
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
