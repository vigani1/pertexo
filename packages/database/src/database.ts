import { Pool } from 'pg';

import type { DatabaseConfig } from './config.js';
import { checkDatabaseReadiness } from './readiness.js';
import type { DatabaseReadiness } from './readiness.js';
import { withWorkspaceTransaction } from './workspace.js';
import type { WorkspaceTransaction } from './workspace.js';

export interface WorkspaceDatabase {
  withWorkspace<T>(
    workspaceId: string,
    operation: (transaction: WorkspaceTransaction) => Promise<T>,
  ): Promise<T>;
  checkReadiness(): Promise<DatabaseReadiness>;
  close(): Promise<void>;
}

export function createWorkspaceDatabase(
  config: DatabaseConfig,
): WorkspaceDatabase {
  const pool = new Pool(config);

  return Object.freeze({
    withWorkspace: async <T>(
      workspaceId: string,
      operation: (transaction: WorkspaceTransaction) => Promise<T>,
    ): Promise<T> => withWorkspaceTransaction(pool, workspaceId, operation),
    checkReadiness: async (): Promise<DatabaseReadiness> =>
      checkDatabaseReadiness(pool, { ownerRole: config.ownerRole }),
    close: async (): Promise<void> => pool.end(),
  });
}
