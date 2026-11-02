import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';

import type { DatabaseConfig } from '@pertexo/database/platform';

import type {
  ScanDueInput,
  ScanDueSchedulesResult,
  ScannerResources,
} from './scanning/contract.js';
import {
  cancellationFailure,
  claimDueSchedules,
  closeScheduleScannerLeases,
} from './scanning/leases.repository.js';
import {
  processScheduleClaim,
  ScanInterruptedError,
} from './scanning/occurrences.repository.js';
import { releaseClaims } from './retirement.repository.js';
/**
 * Each claim stands alone: one that can't fire is retired and the rest still fire.
 * Its failure is thrown once the batch is done. Only a cancelled scan, or a database
 * too unwell to retire a claim, stops the batch; what's left is then released.
 */
async function scanDueSchedules(
  resources: ScannerResources,
  input: ScanDueInput,
): Promise<ScanDueSchedulesResult> {
  const onTimeWindowSeconds = input.onTimeWindowSeconds;
  const batch = await claimDueSchedules(resources.claimPool, input);
  const outcomes = { accepted: 0, deferred: 0, paused: 0, skipped: 0 };
  const failures: unknown[] = [];
  let maxLagSeconds = 0;
  for (const [index, claim] of batch.claims.entries()) {
    const remaining = () => batch.claims.slice(index);
    const cancellation = cancellationFailure(input.signal);
    if (cancellation !== undefined) {
      await releaseClaims(resources.claimPool, remaining());
      throw cancellation;
    }
    try {
      const outcome = await processScheduleClaim(
        resources,
        claim,
        input,
        onTimeWindowSeconds,
      );
      outcomes[outcome.kind] += 1;
      maxLagSeconds = Math.max(maxLagSeconds, outcome.lagSeconds);
    } catch (error: unknown) {
      if (error instanceof ScanInterruptedError) {
        await releaseClaims(resources.claimPool, remaining().slice(1));
        throw error.cause;
      }
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'Schedule scan failed');
  return Object.freeze({
    claimed: batch.claimed,
    ...outcomes,
    maxLagSeconds,
  });
}

export type ScheduleTriggerScanner = ReturnType<
  typeof createScheduleTriggerScanner
>;

/** The worker firing what's due: no member behind it, so it stays off the helper. */
export function createScheduleTriggerScanner(
  claimConfig: DatabaseConfig,
  acceptanceConfig: DatabaseConfig,
  runtimes: Readonly<{
    acceptance?: DatabaseRuntime;
    claim?: DatabaseRuntime;
  }> = {},
) {
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
