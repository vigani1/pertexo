import type { QueryResultRow } from 'pg';

import { readinessPool, workerPool } from './base.js';
import { workspaceId } from './context.js';

export async function workerQuery<Row extends QueryResultRow = QueryResultRow>(
  statement: string,
  parameters: unknown[] = [],
) {
  const client = await workerPool.connect();
  let releaseClient = (): void => {
    client.release();
  };
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await client.query<Row>(statement, parameters);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    try {
      await client.query('rollback');
    } catch (rollbackError: unknown) {
      releaseClient = () => undefined;
      try {
        client.release(
          new Error('Webhook fixture worker rollback failed', {
            cause: rollbackError,
          }),
        );
      } catch {
        // Preserve the scenario failure after attempting to discard the client.
      }
    }
    throw error;
  } finally {
    releaseClient();
  }
}

export async function apiQuery<Row extends QueryResultRow = QueryResultRow>(
  statement: string,
  parameters: unknown[] = [],
) {
  const client = await readinessPool.connect();
  let releaseClient = (): void => {
    client.release();
  };
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await client.query<Row>(statement, parameters);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    try {
      await client.query('rollback');
    } catch (rollbackError: unknown) {
      releaseClient = () => undefined;
      try {
        client.release(
          new Error('Webhook fixture API rollback failed', {
            cause: rollbackError,
          }),
        );
      } catch {
        // Preserve the scenario failure after attempting to discard the client.
      }
    }
    throw error;
  } finally {
    releaseClient();
  }
}
