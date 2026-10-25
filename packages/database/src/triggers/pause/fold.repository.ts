import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type {
  WorkflowTriggerPauseDecision,
  WorkflowTriggerPauseFoldStore,
} from './contract.js';

import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import { checkDatabaseReadiness } from '../../platform/readiness.queries.js';
import { withPlatformTransaction } from '../../tenant-access/transactions.js';

const STATEMENT_TIMEOUT_MILLIS = 5_000;
/** ADR 056: the worker's streak fold, run across workspaces. */
export function createWorkflowTriggerPauseFoldStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkflowTriggerPauseFoldStore {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    checkReadiness: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      await checkDatabaseReadiness(pool);
    },
    foldPending: (limit: number, signal?: AbortSignal) => {
      const bounded = limit;
      return withPlatformTransaction(
        pool,
        async (client) => {
          const result = await drizzle(client)
            .execute<WorkflowTriggerPauseDecision>(
              sql`
            select workspace_id "workspaceId",workflow_id "workflowId",consecutive_failures "consecutiveFailures"
            from app.fold_workflow_trigger_outcomes(${bounded})`,
            )
            .catch(rethrowQueryFailure);
          return Object.freeze(result.rows.map((row) => Object.freeze(row)));
        },
        {
          ...(signal === undefined ? {} : { signal }),
          statementTimeoutMillis: STATEMENT_TIMEOUT_MILLIS,
        },
      );
    },
    close: () => lease.close(),
  });
}
