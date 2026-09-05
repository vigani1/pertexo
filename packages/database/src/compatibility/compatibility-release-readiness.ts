import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';

import type { DatabaseConfig } from '../config.js';
import type {
  CompatibilityReleaseExpectation,
  CompatibilityReleaseExpectationSet,
} from './compatibility-release.js';
import {
  checkDatabasePreactivationReadiness,
  checkDatabaseReadiness,
  type DatabaseReadiness,
} from '../platform/readiness.js';

export interface CompatibilityReleaseReadinessProbe {
  checkCurrent(): Promise<DatabaseReadiness>;
  checkTarget(
    target: CompatibilityReleaseExpectation,
  ): Promise<DatabaseReadiness>;
  close(): Promise<void>;
}

export function createCompatibilityReleaseReadinessProbe(
  config: DatabaseConfig,
  supported: CompatibilityReleaseExpectationSet,
  runtime?: DatabaseRuntime,
): CompatibilityReleaseReadinessProbe {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  const options = Object.freeze({
    ownerRole: config.ownerRole,
    workerRuntimeRole: config.workerRuntimeRole,
    expectedCompatibilityReleases: supported,
  });
  return Object.freeze({
    checkCurrent: (): Promise<DatabaseReadiness> =>
      checkDatabaseReadiness(pool, options),
    checkTarget: (
      target: CompatibilityReleaseExpectation,
    ): Promise<DatabaseReadiness> =>
      checkDatabasePreactivationReadiness(pool, {
        ...options,
        preactivationTarget: target,
      }),
    close: () => lease.close(),
  });
}
