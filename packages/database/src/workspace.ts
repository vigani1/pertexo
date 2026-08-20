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

export function parseWorkspaceId(value: string): WorkspaceId {
  return workspaceIdSchema.parse(value) as WorkspaceId;
}

async function assertNoWorkspaceContext(client: PoolClient): Promise<void> {
  const result = await client.query<{ workspace_id: string | null }>(
    "select current_setting('app.workspace_id', true) as workspace_id",
  );
  const value = result.rows[0]?.workspace_id;
  if (value !== undefined && value !== null && value !== '') {
    throw new Error('Pooled PostgreSQL client retained workspace context');
  }
}

export async function withWorkspaceTransaction<T>(
  pool: Pool,
  workspaceIdInput: string,
  operation: (transaction: WorkspaceTransaction) => Promise<T>,
  options: WorkspaceTransactionOptions = {},
): Promise<T> {
  const workspaceId = parseWorkspaceId(workspaceIdInput);
  const abortError = new Error('Workspace transaction aborted');
  abortError.name = 'AbortError';
  if (options.signal?.aborted) throw abortError;

  const client = await pool.connect();
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
    await assertNoWorkspaceContext(client);
    await client.query('begin');
    transactionOpen = true;
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);

    const contextResult = await client.query<{ workspace_id: string }>(
      "select current_setting('app.workspace_id', true) as workspace_id",
    );
    if (contextResult.rows[0]?.workspace_id !== workspaceId) {
      throw new Error('PostgreSQL workspace context verification failed');
    }

    const db = drizzle(client, { schema: databaseSchema });
    const result = await operation(Object.freeze({ db, workspaceId }));
    await client.query('commit');
    transactionOpen = false;
    await assertNoWorkspaceContext(client);
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
        throw new AggregateError(
          [error, rollbackError],
          'Workspace transaction rollback failed',
        );
      }
    }

    try {
      await assertNoWorkspaceContext(client);
      clientReleased = true;
      client.release();
    } catch (cleanupError: unknown) {
      destroyClient();
      if (options.signal?.aborted) throw abortError;
      throw new AggregateError(
        [error, cleanupError],
        'Workspace context cleanup failed',
      );
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', releaseForAbort);
  }
}
