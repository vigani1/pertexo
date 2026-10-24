import type { Pool, PoolClient, QueryResult } from 'pg';
import type { DatabaseConfig } from '../../config.js';
import { acquireDatabasePool, type DatabaseRuntime } from '../pool/runtime.js';
import { acquireAbortablePoolClient } from '../pool/abortable-checkout.js';
import { destroyCanceledPoolClient } from '../pool/client-disposal.js';
import { checkDatabaseReadiness } from '../readiness.queries.js';

export type StoredEncryptionKey = Readonly<{
  kind: 'connection' | 'webhook';
  workspaceId: string;
  resourceId: string;
  secretVersionId: string;
  keyReference: string;
  encryptedDataKey: string;
}>;
export type EncryptionKeyRepository = Readonly<{
  read(signal: AbortSignal): AsyncIterable<StoredEncryptionKey>;
  close(): Promise<void>;
}>;
interface KeyRow {
  id: string;
  workspace_id: string;
  resource_id: string;
  kms_key_reference: string;
  encrypted_data_key: string;
}
const inventories = [
  {
    kind: 'webhook',
    table: 'webhook_test_events',
    resource: 'id',
    retained: 'expires_at>clock_timestamp()',
  },
  {
    kind: 'connection',
    table: 'connection_secret_versions',
    resource: 'connection_id',
    retained: 'true',
  },
  {
    kind: 'webhook',
    table: 'webhook_trigger_secret_versions',
    resource: 'trigger_id',
    retained: 'true',
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
        const page: QueryResult<KeyRow> = await client.query<KeyRow>(
          `select id, workspace_id, ${inventory.resource} as resource_id, kms_key_reference, encrypted_data_key
             from app.${inventory.table}
            where ${inventory.retained} and ($1::uuid is null or id > $1::uuid)
            order by id limit 250`,
          [after],
        );
        signal.throwIfAborted();
        for (const row of page.rows) {
          signal.throwIfAborted();
          after = row.id;
          yield Object.freeze({
            kind: inventory.kind,
            workspaceId: row.workspace_id,
            resourceId: row.resource_id,
            secretVersionId: row.id,
            keyReference: row.kms_key_reference,
            encryptedDataKey: row.encrypted_data_key,
          });
        }
        if (page.rows.length < 250) break;
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
