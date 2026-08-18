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

export function parseWorkspaceId(value: string): WorkspaceId {
  return workspaceIdSchema.parse(value) as WorkspaceId;
}

async function clearWorkspaceContext(client: PoolClient): Promise<void> {
  await client.query("select set_config('app.workspace_id', '', false)");
}

export async function withWorkspaceTransaction<T>(
  pool: Pool,
  workspaceIdInput: string,
  operation: (transaction: WorkspaceTransaction) => Promise<T>,
): Promise<T> {
  const workspaceId = parseWorkspaceId(workspaceIdInput);
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await clearWorkspaceContext(client);
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
    await clearWorkspaceContext(client);
    client.release();
    return result;
  } catch (error: unknown) {
    if (transactionOpen) {
      try {
        await client.query('rollback');
      } catch (rollbackError: unknown) {
        client.release(true);
        throw new AggregateError(
          [error, rollbackError],
          'Workspace transaction rollback failed',
        );
      }
    }

    try {
      await clearWorkspaceContext(client);
      client.release();
    } catch (cleanupError: unknown) {
      client.release(true);
      throw new AggregateError(
        [error, cleanupError],
        'Workspace context cleanup failed',
      );
    }
    throw error;
  }
}
