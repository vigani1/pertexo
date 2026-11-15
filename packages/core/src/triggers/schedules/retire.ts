import { withPlatformTransaction } from '@pertexo/database/platform';
import type { Pool } from 'pg';

import { readDatabaseClock } from '../../shared/database-clock.repository.js';
import { planRetirement } from './retirement-plan.js';
import {
  releaseScheduleClaim,
  storeScheduleRetirement,
  type RetirableClaim,
} from './retirement.repository.js';
import type { ClaimRetirement } from './scanning/schedule-scanning.types.js';

/** How long releasing or retiring one claim may take. */
export const CLAIM_CLEANUP_TIMEOUT_MILLIS = 5_000;

export async function retireScheduleClaim(
  pool: Pool,
  claim: RetirableClaim,
  retirement: ClaimRetirement,
  signal: AbortSignal,
): Promise<void> {
  await withPlatformTransaction(
    pool,
    async (client) => {
      const plan = planRetirement(retirement);
      if (plan.kind === 'release') {
        await releaseScheduleClaim(client, claim);
        return;
      }
      const observed = await readDatabaseClock(client);
      await storeScheduleRetirement(client, claim, {
        health: plan.health,
        reason: plan.reason,
        retryAt: new Date(observed.getTime() + plan.retrySeconds * 1_000),
      });
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
  const signal = AbortSignal.timeout(CLAIM_CLEANUP_TIMEOUT_MILLIS);
  for (const claim of claims)
    await retireScheduleClaim(pool, claim, { kind: 'release' }, signal).catch(
      () => undefined,
    );
}
