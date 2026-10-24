import type {
  StoredEncryptionKey,
  EncryptionKeyRepository,
} from './contract.js';
import { and, asc, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { webhookTestEvents } from '../../schema/triggers/test-events.js';
import { webhookTriggerSecretVersions } from '../../schema/triggers/endpoints.js';
import { connectionSecretVersions } from '../../schema/connections.js';
import type { Pool, PoolClient } from 'pg';
import type { DatabaseConfig } from '../../config.js';
import { acquireDatabasePool, type DatabaseRuntime } from '../pool/runtime.js';
import { acquireAbortablePoolClient } from '../pool/abortable-checkout.js';
import { destroyCanceledPoolClient } from '../pool/client-disposal.js';
import { checkDatabaseReadiness } from '../readiness.queries.js';
const inventories = [
  {
    kind: 'webhook',
    table: webhookTestEvents,
    resource: webhookTestEvents.id,
    retained: gt(webhookTestEvents.expiresAt, sql`clock_timestamp()`),
  },
  {
    kind: 'connection',
    table: connectionSecretVersions,
    resource: connectionSecretVersions.connectionId,
    retained: undefined,
  },
  {
    kind: 'webhook',
    table: webhookTriggerSecretVersions,
    resource: webhookTriggerSecretVersions.triggerId,
    retained: undefined,
  },
] as const;

interface ClientLifecycle {
  released: boolean;
  transactionOpen: boolean;
}
interface RepositoryState {
  cleanupFailure?: Error;
}

async function finishClient(
  client: PoolClient,
  lifecycle: ClientLifecycle,
  signal: AbortSignal,
): Promise<Error | undefined> {
  if (lifecycle.released) return undefined;
  try {
    if (lifecycle.transactionOpen) await client.query('rollback');
    if (!signal.aborted) {
      lifecycle.released = true;
      client.release();
    }
  } catch {
    if (signal.aborted) return undefined;
    lifecycle.released = true;
    client.release(true);
    return new Error('Encryption key inventory cleanup failed');
  }
  return undefined;
}

async function* readKeys(
  pool: Pool,
  signal: AbortSignal,
  state: RepositoryState,
): AsyncGenerator<StoredEncryptionKey> {
  if (state.cleanupFailure !== undefined) throw state.cleanupFailure;
  const abortError = new Error('Encryption key inventory was cancelled');
  abortError.name = 'AbortError';
  const client = await acquireAbortablePoolClient(
    pool,
    signal,
    () => abortError,
    (late) => {
      late.release(abortError);
    },
  );
  const lifecycle: ClientLifecycle = {
    released: false,
    transactionOpen: false,
  };
  const onAbort = (): void => {
    if (lifecycle.released) return;
    lifecycle.released = true;
    try {
      destroyCanceledPoolClient(client, abortError);
    } catch {
      /* Cancellation remains authoritative after socket disposal. */
    }
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) {
      onAbort();
      throw abortError;
    }
    await checkDatabaseReadiness(client);
    signal.throwIfAborted();
    await client.query('begin isolation level repeatable read read only');
    lifecycle.transactionOpen = true;
    for (const inventory of inventories) {
      let after: string | null = null;
      for (;;) {
        signal.throwIfAborted();
        const page: Omit<StoredEncryptionKey, 'kind'>[] = await drizzle(client)
          .select({
            secretVersionId: inventory.table.id,
            workspaceId: inventory.table.workspaceId,
            resourceId: inventory.resource,
            keyReference: inventory.table.kmsKeyReference,
            encryptedDataKey: inventory.table.encryptedDataKey,
          })
          .from(inventory.table)
          .where(
            and(
              inventory.retained,
              after === null ? undefined : gt(inventory.table.id, after),
            ),
          )
          .orderBy(asc(inventory.table.id))
          .limit(250);
        signal.throwIfAborted();
        for (const row of page) {
          signal.throwIfAborted();
          after = row.secretVersionId;
          yield Object.freeze({ kind: inventory.kind, ...row });
        }
        if (page.length < 250) break;
      }
    }
    signal.throwIfAborted();
    await client.query('commit');
    lifecycle.transactionOpen = false;
  } catch {
    if (signal.aborted) throw abortError;
    throw new Error('Encryption key inventory is unavailable');
  } finally {
    const cleanupFailure = await finishClient(client, lifecycle, signal);
    if (cleanupFailure !== undefined) state.cleanupFailure = cleanupFailure;
    signal.removeEventListener('abort', onAbort);
  }
  if (state.cleanupFailure !== undefined) throw state.cleanupFailure;
}

export function createEncryptionKeyRepository(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): EncryptionKeyRepository {
  const lease = acquireDatabasePool(config, runtime, {
    role: 'maintenance',
    monitorLockWaits: false,
  });
  const state: RepositoryState = {};
  return Object.freeze({
    read: (signal: AbortSignal) => readKeys(lease.pool, signal, state),
    close: async (): Promise<void> => {
      await lease.close();
      // Early iterator return skips code after finally; its owner still observes cleanup failure.
      if (state.cleanupFailure !== undefined) throw state.cleanupFailure;
    },
  });
}
