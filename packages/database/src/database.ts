import { acquireDatabasePool } from './platform/pool/runtime.js';
import type { DatabaseRuntime } from './platform/pool/runtime.js';

import type { DatabaseConfig } from './config.js';
import type { InstanceCapacity } from './runs/capacity/instance-limits.js';
import {
  checkDatabaseReadiness,
  checkDatabaseWrites,
} from './platform/readiness.queries.js';
import type { DatabaseReadiness } from './platform/contract.js';
import { withWorkspaceTransaction } from './tenant-access/transactions.js';
import type {
  WorkspaceTransaction,
  WorkspaceTransactionOptions,
} from './tenant-access/transactions.js';

export interface WorkspaceDatabase {
  withWorkspace<T>(
    workspaceId: string,
    operation: (transaction: WorkspaceTransaction) => Promise<T>,
    options?: WorkspaceTransactionOptions,
  ): Promise<T>;
  checkReadiness(): Promise<DatabaseReadiness>;
  /** Writes the operator's limits, for new and existing workspaces alike. */
  applyInstanceCapacity(limits: InstanceCapacity): Promise<void>;
  close(): Promise<void>;
}

export function createWorkspaceDatabase(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
): WorkspaceDatabase {
  const lease = acquireDatabasePool(config, options.runtime);
  const { pool } = lease;
  return Object.freeze({
    withWorkspace: async <T>(
      workspaceId: string,
      operation: (transaction: WorkspaceTransaction) => Promise<T>,
      options?: WorkspaceTransactionOptions,
    ): Promise<T> =>
      withWorkspaceTransaction(pool, workspaceId, operation, options),
    checkReadiness: async (): Promise<DatabaseReadiness> => {
      const readiness = await checkDatabaseReadiness(pool);
      await checkDatabaseWrites(pool);
      return readiness;
    },
    applyInstanceCapacity: async (limits: InstanceCapacity) => {
      await pool.query('select app.apply_instance_capacity($1,$2,$3)', [
        limits.activeRunLimit,
        limits.queuedRunLimit,
        limits.artifactCountLimit,
      ]);
    },
    close: (): Promise<void> => lease.close(),
  });
}
