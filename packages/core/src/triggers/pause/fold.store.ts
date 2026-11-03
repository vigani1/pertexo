import { checkDatabaseReadiness } from '@pertexo/database/primitives';
import { foldTriggerOutcomes } from './fold.repository.js';

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

/**
 * Cross-workspace maintenance with no acting member stays off
 * `withWorkspaceAccess`. The workspace advisory key must precede its row lock.
 */
export function createWorkflowTriggerPauseFoldStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;
  return Object.freeze({
    checkReadiness: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      await checkDatabaseReadiness(pool);
    },
    /** Folds up to `limit` outcomes into streaks, pausing workflows that reach their threshold. */
    foldPending: (limit: number, signal?: AbortSignal) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
        throw new RangeError(
          'Trigger outcome fold limit must be between 1 and 1000',
        );
      return withPlatformTransaction(
        pool,
        (client) => foldTriggerOutcomes(client, limit),
        {
          ...(signal === undefined ? {} : { signal }),
          statementTimeoutMillis: STATEMENT_TIMEOUT_MILLIS,
        },
      );
    },
    close: () => lease.close(),
  });
}
