import type { Pool } from 'pg';

import { withPlatformTransaction } from '../../tenant-access/transactions.js';

/** A schedule claim the scanner holds: the trigger and its lease. */
type RetirableClaim = Readonly<{ trigger_id: string; lease_token: string }>;
export type ClaimRetirement =
  | Readonly<{ kind: 'defer'; retryAfterSeconds: number }>
  | Readonly<{ kind: 'fail' | 'release' }>;

export const claimCleanupTimeoutMillis = 5_000;

export async function retireScheduleClaim(
  pool: Pool,
  claim: RetirableClaim,
  retirement: ClaimRetirement,
  signal: AbortSignal,
): Promise<void> {
  await withPlatformTransaction(
    pool,
    async (client) => {
      if (retirement.kind === 'defer') {
        await client.query(
          'select app.defer_trigger_schedule_claim($1,$2,$3)',
          [claim.trigger_id, claim.lease_token, retirement.retryAfterSeconds],
        );
        return;
      }
      await client.query(
        retirement.kind === 'fail'
          ? 'select app.fail_trigger_schedule_claim($1,$2)'
          : 'select app.release_trigger_schedule_claim($1,$2)',
        [claim.trigger_id, claim.lease_token],
      );
    },
    { signal },
  );
}

/**
 * Retire the current claim according to its outcome and release every later
 * validated claim. Cleanup is bounded and diagnostic only: it cannot replace
 * the failure that interrupted the batch.
 */
export async function retireInterruptedBatch(
  pool: Pool,
  claims: readonly RetirableClaim[],
  first: ClaimRetirement,
): Promise<readonly unknown[]> {
  const signal = AbortSignal.timeout(claimCleanupTimeoutMillis);
  const failures: unknown[] = [];
  for (const [index, claim] of claims.entries()) {
    try {
      await retireScheduleClaim(
        pool,
        claim,
        index === 0 ? first : { kind: 'release' },
        signal,
      );
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  return Object.freeze(failures);
}
