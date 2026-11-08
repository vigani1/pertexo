import type { StoredEncryptionKey } from './stored-encryption-key.types.js';
import { and, asc, gt, isNotNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  connectionOAuth2Tokens,
  connectionSecretVersions,
  workflowForms,
  webhookTestEvents,
  webhookTriggerSecretVersions,
} from '@pertexo/database/schema';
import type { Pool, PoolClient } from 'pg';
import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  acquireAbortablePoolClient,
  checkDatabaseReadiness,
  destroyCanceledPoolClient,
} from '@pertexo/database/primitives';

const PAGE_SIZE = 250;

const columnInventories = [
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
    kind: 'connection',
    table: connectionOAuth2Tokens,
    resource: connectionOAuth2Tokens.connectionId,
    retained: undefined,
  },
  {
    kind: 'webhook',
    table: webhookTriggerSecretVersions,
    resource: webhookTriggerSecretVersions.triggerId,
    retained: undefined,
  },
] as const;

const inventories = [
  ...columnInventories.map(({ kind, table, resource, retained }) => ({
    kind,
    table,
    retained,
    selection: {
      secretVersionId: table.id,
      workspaceId: table.workspaceId,
      resourceId: resource,
      keyReference: table.kmsKeyReference,
      encryptedDataKey: table.encryptedDataKey,
    },
  })),
  {
    // Form capabilities use connection envelopes with both context IDs bound to the workflow.
    kind: 'connection',
    table: workflowForms,
    retained: isNotNull(workflowForms.sealedCapability),
    selection: {
      secretVersionId: workflowForms.workflowId,
      workspaceId: workflowForms.workspaceId,
      resourceId: workflowForms.workflowId,
      keyReference: sql<string>`${workflowForms.sealedCapability}->>'kmsKeyReference'`,
      encryptedDataKey: sql<string>`${workflowForms.sealedCapability}->>'encryptedDataKey'`,
    },
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
          .select(inventory.selection)
          .from(inventory.table)
          .where(
            and(
              inventory.retained,
              after === null
                ? undefined
                : gt(inventory.selection.secretVersionId, after),
            ),
          )
          .orderBy(asc(inventory.selection.secretVersionId))
          .limit(PAGE_SIZE);
        signal.throwIfAborted();
        for (const row of page) {
          signal.throwIfAborted();
          after = row.secretVersionId;
          yield Object.freeze({ kind: inventory.kind, ...row });
        }
        if (page.length < PAGE_SIZE) break;
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

export type EncryptionKeyRepository = ReturnType<
  typeof createEncryptionKeyRepository
>;

/**
 * Reads every stored key across workspaces, for startup verification and key
 * rotation. No member stands behind it, so it takes the maintenance role and no
 * workspace's authority.
 */
export function createEncryptionKeyRepository(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime, {
    role: 'maintenance',
    monitorLockWaits: false,
  });
  const state: RepositoryState = {};
  return Object.freeze({
    read: (signal: AbortSignal): AsyncIterable<StoredEncryptionKey> =>
      readKeys(lease.pool, signal, state),
    close: async (): Promise<void> => {
      await lease.close();
      // Early iterator return skips code after finally; its owner still observes cleanup failure.
      if (state.cleanupFailure !== undefined) throw state.cleanupFailure;
    },
  });
}
