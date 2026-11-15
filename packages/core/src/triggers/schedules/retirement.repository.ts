import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

/** A schedule claim the scanner holds: the trigger and its lease. */
export type RetirableClaim = Readonly<{
  trigger_id: string;
  lease_token: string;
}>;

/** Gives the claim back unchanged. */
export async function releaseScheduleClaim(
  client: PoolClient,
  claim: RetirableClaim,
): Promise<void> {
  await drizzle(client)
    .execute(
      sql`select app.release_trigger_schedule_claim(${claim.trigger_id},${claim.lease_token})`,
    )
    .catch(rethrowQueryFailure);
}

/** Stores the claim's retirement: the schedule's health, why, and its next try. */
export async function storeScheduleRetirement(
  client: PoolClient,
  claim: RetirableClaim,
  retirement: Readonly<{ health: string; reason: string; retryAt: Date }>,
): Promise<void> {
  await drizzle(client)
    .execute(
      sql`select app.store_trigger_schedule_retirement(${claim.trigger_id},${claim.lease_token},${retirement.health},${retirement.reason},${retirement.retryAt})`,
    )
    .catch(rethrowQueryFailure);
}
