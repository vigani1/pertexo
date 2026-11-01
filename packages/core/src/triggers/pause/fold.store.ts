import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  rethrowQueryFailure,
  checkDatabaseReadiness,
} from '@pertexo/database/primitives';
import type { WorkflowTriggerPauseDecision } from './contract.js';

import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
  withPlatformTransaction,
} from '@pertexo/database/platform';

const STATEMENT_TIMEOUT_MILLIS = 5_000;
export type WorkflowTriggerPauseFoldStore = ReturnType<
  typeof createWorkflowTriggerPauseFoldStore
>;

/** ADR 056: the worker's streak fold, run across workspaces. No member is acting. */
export function createWorkflowTriggerPauseFoldStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    checkReadiness: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      await checkDatabaseReadiness(pool);
    },
    /** Folds up to `limit` outcomes into streaks, pausing workflows that reach their threshold. */
    foldPending: (limit: number, signal?: AbortSignal) =>
      withPlatformTransaction(
        pool,
        async (client) => {
          const result = await drizzle(client)
            .execute<WorkflowTriggerPauseDecision>(
              sql`
            select workspace_id "workspaceId",workflow_id "workflowId",consecutive_failures "consecutiveFailures"
            from app.fold_workflow_trigger_outcomes(${limit})`,
            )
            .catch(rethrowQueryFailure);
          return Object.freeze(result.rows.map((row) => Object.freeze(row)));
        },
        {
          ...(signal === undefined ? {} : { signal }),
          statementTimeoutMillis: STATEMENT_TIMEOUT_MILLIS,
        },
      ),
    close: () => lease.close(),
  });
}
