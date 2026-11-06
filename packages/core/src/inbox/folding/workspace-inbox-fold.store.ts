import { checkDatabaseReadiness } from '@pertexo/database/primitives';
import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
  withPlatformTransaction,
} from '@pertexo/database/platform';
import { foldInboxEvents } from './fold-inbox-events.js';
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
        (client) => foldInboxEvents(client, limit),
        options(signal),
      ),
    close: async () => {
      await lease.close();
      await maintenance?.close();
    },
  });
}
