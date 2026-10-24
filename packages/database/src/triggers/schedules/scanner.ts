import { z } from 'zod';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';

import type { DatabaseConfig } from '../../config.js';

import type {
  ScanDueSchedulesResult,
  ScheduleTriggerScanner,
  ScanDueInput,
  ScannerResources,
} from './scanning/contract.js';
import {
  closeScheduleScannerLeases,
  claimDueSchedules,
} from './scanning/leases.repository.js';
import { processScheduleClaim } from './scanning/occurrences.repository.js';

export {
  type ScanDueSchedulesResult,
  type ScheduleTriggerScanner,
  ScheduleClaimLostError,
} from './scanning/contract.js';
export { isScheduleClaimEligible } from './scanning/occurrences.repository.js';
async function scanDueSchedules(
  resources: ScannerResources,
  input: ScanDueInput,
): Promise<ScanDueSchedulesResult> {
  const onTimeWindowSeconds = z
    .number()
    .int()
    .min(60)
    .max(3_600)
    .parse(input.onTimeWindowSeconds);
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
