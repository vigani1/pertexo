import { createDatabasePool } from './postgres-telemetry.js';

import type { DatabaseConfig } from './config.js';
import type { CompatibilityReleaseExpectation } from './compatibility/compatibility-release.js';
import type { CompatibilityReleaseExpectationSet } from './compatibility/compatibility-release.js';
import {
  checkDatabaseReadiness,
  checkDatabaseServingReadiness,
} from './readiness.js';
import type { DatabaseReadiness } from './readiness.js';
import { withWorkspaceTransaction } from './tenant-access/workspace.js';
import type {
  WorkspaceTransaction,
  WorkspaceTransactionOptions,
} from './tenant-access/workspace.js';

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
  const pool = createDatabasePool(config);
  pool.on('error', () => undefined);
  const readinessOptions = {
    ownerRole: config.ownerRole,
    workerRuntimeRole: config.workerRuntimeRole,
    ...(options.compatibilityRelease === undefined
      ? {}
      : { expectedCompatibilityRelease: options.compatibilityRelease }),
    ...(options.compatibilityReleases === undefined
      ? {}
      : { expectedCompatibilityReleases: options.compatibilityReleases }),
  } as const;

  return Object.freeze({
    withWorkspace: async <T>(
      workspaceId: string,
      operation: (transaction: WorkspaceTransaction) => Promise<T>,
      options?: WorkspaceTransactionOptions,
    ): Promise<T> =>
      withWorkspaceTransaction(pool, workspaceId, operation, options),
    checkCompatibility: async (): Promise<DatabaseReadiness> =>
      checkDatabaseReadiness(pool, readinessOptions),
    checkReadiness: async (): Promise<DatabaseReadiness> =>
      checkDatabaseServingReadiness(pool, readinessOptions),
    close: async (): Promise<void> => pool.end(),
  });
}
