import type { ClaimRetirement } from './scanning/schedule-scanning.types.js';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { Pool } from 'pg';

import { withPlatformTransaction } from '@pertexo/database/platform';

/** A schedule claim the scanner holds: the trigger and its lease. */
type RetirableClaim = Readonly<{ trigger_id: string; lease_token: string }>;

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
        await drizzle(client)
          .execute(
            sql`select app.defer_trigger_schedule_claim(${claim.trigger_id},${claim.lease_token},${retirement.retryAfterSeconds})`,
          )
          .catch(rethrowQueryFailure);
        return;
      }
      await drizzle(client)
        .execute(
          retirement.kind === 'fail'
            ? sql`select app.fail_trigger_schedule_claim(${claim.trigger_id},${claim.lease_token})`
            : sql`select app.release_trigger_schedule_claim(${claim.trigger_id},${claim.lease_token})`,
        )
        .catch(rethrowQueryFailure);
    },
    { signal },
  );
}

/**
 * Gives claims back when a scan can't go on. Cleanup is bounded and diagnostic
 * only: it cannot replace the failure that interrupted the batch.
 */
export async function releaseClaims(
  pool: Pool,
  claims: readonly RetirableClaim[],
): Promise<void> {
  const signal = AbortSignal.timeout(claimCleanupTimeoutMillis);
  for (const claim of claims)
    await retireScheduleClaim(pool, claim, { kind: 'release' }, signal).catch(
      () => undefined,
    );
}
