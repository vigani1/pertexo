import { z } from 'zod';

import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import { withPlatformTransaction } from '../../tenant-access/transactions.js';
import { checkDatabaseReadiness } from '../../platform/readiness.js';

/** A workflow whose failure streak reached its threshold in this fold. */
export type WorkflowTriggerPauseDecision = Readonly<{
  workspaceId: string;
  workflowId: string;
  consecutiveFailures: number;
}>;

export interface WorkflowTriggerPauseFoldStore {
  /** Fails unless the fold command is the reviewed one. */
  checkReadiness(signal?: AbortSignal): Promise<void>;
  /**
   * Folds up to `limit` pending run outcomes into their workflows' streaks,
   * pausing workflows that reach their threshold.
   */
  foldPending(
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly WorkflowTriggerPauseDecision[]>;
  close(): Promise<void>;
}

const STATEMENT_TIMEOUT_MILLIS = 5_000;
const limitSchema = z.number().int().min(1).max(1_000);
const decisionRowSchema = z
  .object({
    workspace_id: z.uuid(),
    workflow_id: z.uuid(),
    consecutive_failures: z.number().int().positive(),
    paused: z.boolean(),
  })
  .strict();

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
      const bounded = limitSchema.parse(limit);
      return withPlatformTransaction(
        pool,
        async (client) => {
          // The function's second argument is the former observe-only switch.
          const result = await client.query(
            `select workspace_id,workflow_id,consecutive_failures,paused
               from app.fold_workflow_trigger_outcomes($1)`,
            [bounded],
          );
          return Object.freeze(
            result.rows.map((value) => {
              const row = decisionRowSchema.parse(value);
              return Object.freeze({
                workspaceId: row.workspace_id,
                workflowId: row.workflow_id,
                consecutiveFailures: row.consecutive_failures,
              });
            }),
          );
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
