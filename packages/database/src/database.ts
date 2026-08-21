import { Pool } from 'pg';

import type { DatabaseConfig } from './config.js';
import type { CompatibilityReleaseExpectation } from './compatibility-release.js';
import type { CompatibilityReleaseExpectationSet } from './compatibility-release.js';
import { checkDatabaseReadiness } from './readiness.js';
import type { DatabaseReadiness } from './readiness.js';
import { withWorkspaceTransaction } from './workspace.js';
import type {
  WorkspaceTransaction,
  WorkspaceTransactionOptions,
} from './workspace.js';

export interface WorkspaceDatabase {
  withWorkspace<T>(
    workspaceId: string,
    operation: (transaction: WorkspaceTransaction) => Promise<T>,
    options?: WorkspaceTransactionOptions,
  ): Promise<T>;
  checkReadiness(): Promise<DatabaseReadiness>;
  close(): Promise<void>;
}

export function createWorkspaceDatabase(
  config: DatabaseConfig,
  options: Readonly<{
    compatibilityRelease?: CompatibilityReleaseExpectation;
    compatibilityReleases?: CompatibilityReleaseExpectationSet;
  }> = {},
): WorkspaceDatabase {
  if (
    options.compatibilityRelease !== undefined &&
    options.compatibilityReleases !== undefined
  )
    throw new Error(
      'Compatibility release database configuration is ambiguous',
    );
  const pool = new Pool(config);

  return Object.freeze({
    withWorkspace: async <T>(
      workspaceId: string,
      operation: (transaction: WorkspaceTransaction) => Promise<T>,
      options?: WorkspaceTransactionOptions,
    ): Promise<T> =>
      withWorkspaceTransaction(pool, workspaceId, operation, options),
    checkReadiness: async (): Promise<DatabaseReadiness> =>
      checkDatabaseReadiness(pool, {
        ownerRole: config.ownerRole,
        workerRuntimeRole: config.workerRuntimeRole,
        ...(options.compatibilityRelease === undefined
          ? {}
          : { expectedCompatibilityRelease: options.compatibilityRelease }),
        ...(options.compatibilityReleases === undefined
          ? {}
          : { expectedCompatibilityReleases: options.compatibilityReleases }),
      }),
    close: async (): Promise<void> => pool.end(),
  });
}
