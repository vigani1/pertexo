import { createDatabasePool } from './postgres-telemetry.js';

import type { DatabaseConfig } from './config.js';
import type {
  CompatibilityReleaseExpectation,
  CompatibilityReleaseExpectationSet,
} from './compatibility-release.js';
import {
  checkDatabasePreactivationReadiness,
  checkDatabaseReadiness,
  type DatabaseReadiness,
} from './readiness.js';

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
): CompatibilityReleaseReadinessProbe {
  const pool = createDatabasePool(config);
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
    close: (): Promise<void> => pool.end(),
  });
}
