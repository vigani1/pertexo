import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  rethrowQueryFailure,
  checkDatabaseReadiness,
} from '@pertexo/database/primitives';
import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
  withPlatformTransaction,
} from '@pertexo/database/platform';
import { NOTICE_WINDOW_SQL } from '../lifetime.js';
import { createAttentionObserver } from '../observations/observe.js';

const STATEMENT_TIMEOUT_MILLIS = 5_000;

export type WorkspaceInboxFoldStore = ReturnType<
  typeof createWorkspaceInboxFoldStore
>;

/**
 * ADR 055: the worker's fold command, run across workspaces. No member is behind
 * it, so it stays off `withWorkspaceAccess`.
 */
export function createWorkspaceInboxFoldStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
  maintenanceConfig?: DatabaseConfig,
) {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  const maintenance =
    maintenanceConfig === undefined
      ? undefined
      : acquireDatabasePool(maintenanceConfig);
  const observer =
    maintenance === undefined
      ? undefined
      : createAttentionObserver(pool, maintenance.pool);
  const options = (signal: AbortSignal | undefined) => ({
    ...(signal === undefined ? {} : { signal }),
    statementTimeoutMillis: STATEMENT_TIMEOUT_MILLIS,
  });
  return Object.freeze({
    ...(observer === undefined ? {} : { observeCurrent: observer }),
    /** Fails unless the database is at the expected migration. */
    checkReadiness: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      await checkDatabaseReadiness(pool);
    },
    /** Folds up to `limit` pending failures into their workflows' threads. */
    foldPending: (limit: number, signal?: AbortSignal) =>
      withPlatformTransaction(
        pool,
        async (client) => {
          // The cross-workspace fold function owns queue claiming and revision allocation.
          const result = await drizzle(client)
            .execute<{ workspace_id: string; revision: string }>(
              sql`select workspace_id,revision::text from app.fold_workspace_inbox_events(${limit},${NOTICE_WINDOW_SQL})`,
            )
            .catch(rethrowQueryFailure);
          return Object.freeze(
            result.rows.map((row) =>
              Object.freeze({
                workspaceId: row.workspace_id,
                revision: row.revision,
              }),
            ),
          );
        },
        options(signal),
      ),
    close: async () => {
      await lease.close();
      await maintenance?.close();
    },
  });
}
