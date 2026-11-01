import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';

import type { DatabaseConfig } from '@pertexo/database/platform';

import type {
  ScanDueInput,
  ScanDueSchedulesResult,
  ScannerResources,
  ScheduleTriggerScanner,
} from './scanning/contract.js';
import {
  claimDueSchedules,
  closeScheduleScannerLeases,
} from './scanning/leases.repository.js';
import { processScheduleClaim } from './scanning/occurrences.repository.js';
async function scanDueSchedules(
  resources: ScannerResources,
  input: ScanDueInput,
): Promise<ScanDueSchedulesResult> {
  const onTimeWindowSeconds = input.onTimeWindowSeconds;
  const batch = await claimDueSchedules(resources.claimPool, input);
  const outcomes = { accepted: 0, deferred: 0, paused: 0, skipped: 0 };
  let maxLagSeconds = 0;
  for (const [index] of batch.claims.entries()) {
    const outcome = await processScheduleClaim(
      resources,
      batch.claims.slice(index),
      input,
      onTimeWindowSeconds,
    );
    outcomes[outcome.kind] += 1;
    maxLagSeconds = Math.max(maxLagSeconds, outcome.lagSeconds);
  }
  return Object.freeze({
    claimed: batch.claimed,
    ...outcomes,
    maxLagSeconds,
  });
}

export function createScheduleTriggerScanner(
  claimConfig: DatabaseConfig,
  acceptanceConfig: DatabaseConfig,
  runtimes: Readonly<{
    acceptance?: DatabaseRuntime;
    claim?: DatabaseRuntime;
  }> = {},
): ScheduleTriggerScanner {
  const claimLease = acquireDatabasePool(claimConfig, runtimes.claim);
  let acceptanceLease: ReturnType<typeof acquireDatabasePool>;
  try {
    acceptanceLease = acquireDatabasePool(
      acceptanceConfig,
      runtimes.acceptance,
    );
  } catch (error: unknown) {
    void claimLease.close().catch(() => undefined);
    throw error;
  }
  const resources: ScannerResources = Object.freeze({
    acceptancePool: acceptanceLease.pool,
    claimPool: claimLease.pool,
  });
  return Object.freeze({
    scanDue: (input: ScanDueInput) => scanDueSchedules(resources, input),
    close: () => closeScheduleScannerLeases(claimLease, acceptanceLease),
  });
}
