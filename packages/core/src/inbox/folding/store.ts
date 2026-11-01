import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  rethrowQueryFailure,
  checkDatabaseReadiness,
} from '@pertexo/database/primitives';
import { createAttentionObserver } from '../observations/observe.js';
import type { WorkspaceInboxFoldStore } from './contract.js';

import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
  withPlatformTransaction,
} from '@pertexo/database/platform';

const STATEMENT_TIMEOUT_MILLIS = 5_000;
/** ADR 055: the worker's fold command, run across workspaces. */
export function createWorkspaceInboxFoldStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
  maintenanceConfig?: DatabaseConfig,
): WorkspaceInboxFoldStore {
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
    checkReadiness: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      await checkDatabaseReadiness(pool);
    },
    foldPending: (limit: number, signal?: AbortSignal) => {
      const bounded = limit;
      return withPlatformTransaction(
        pool,
        async (client) => {
          // The cross-workspace fold function owns queue claiming and revision allocation.
          const result = await drizzle(client)
            .execute<{ workspace_id: string; revision: string }>(
              sql`select workspace_id,revision::text from app.fold_workspace_inbox_events(${bounded})`,
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
      );
    },
    close: async () => {
      await lease.close();
      await maintenance?.close();
    },
  });
}
