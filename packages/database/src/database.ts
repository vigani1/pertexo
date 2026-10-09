import { acquireDatabasePool } from './platform/pool/runtime.js';
import type { DatabaseRuntime } from './platform/pool/runtime.js';

import type { DatabaseConfig } from './config.js';
import { checkDatabaseReadiness } from './platform/readiness.js';
import type { DatabaseReadiness } from './platform/readiness.js';
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
  checkCompatibility(): Promise<DatabaseReadiness>;
  checkReadiness(): Promise<DatabaseReadiness>;
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
    checkCompatibility: async (): Promise<DatabaseReadiness> =>
      checkDatabaseReadiness(pool),
    checkReadiness: async (): Promise<DatabaseReadiness> =>
      checkDatabaseReadiness(pool),
    close: (): Promise<void> => lease.close(),
  });
}
