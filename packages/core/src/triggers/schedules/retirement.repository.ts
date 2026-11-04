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
      if (retirement.kind === 'release') {
        await drizzle(client)
          .execute(
            sql`select app.release_trigger_schedule_claim(${claim.trigger_id},${claim.lease_token})`,
          )
          .catch(rethrowQueryFailure);
        return;
      }
      const retrySeconds =
        retirement.kind === 'defer' ? retirement.retryAfterSeconds : 60;
      if (
        !Number.isInteger(retrySeconds) ||
        retrySeconds < 1 ||
        retrySeconds > 300
      )
        throw new RangeError('Invalid schedule admission backoff');
      const reason =
        retirement.kind === 'defer'
          ? 'schedule.admission_throttled'
          : retirement.reason;
      const health =
        retirement.kind === 'fail' &&
        retirement.reason !== 'schedule.scan_failed'
          ? 'unhealthy'
          : 'degraded';
      const observation = await drizzle(client)
        .execute<{ observed_at: string }>(
          sql`select clock_timestamp() observed_at`,
        )
        .catch(rethrowQueryFailure);
      const observed = observation.rows[0]?.observed_at;
      if (observed === undefined)
        throw new Error('Schedule retirement database time is unavailable');
      const retryAt = new Date(
        new Date(observed).getTime() + retrySeconds * 1_000,
      );
      await drizzle(client)
        .execute(
          sql`select app.store_trigger_schedule_retirement(${claim.trigger_id},${claim.lease_token},${health},${reason},${retryAt})`,
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
