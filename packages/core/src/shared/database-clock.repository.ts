import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

/** A pg client, or the drizzle database a transaction runs on. */
export type DatabaseClockSource = PoolClient | Pick<NodePgDatabase, 'execute'>;

/**
 * The database's time now, not the transaction's start: a flow that waited
 * on a lock may have crossed an expiry meanwhile without its row changing,
 * so it samples after its lock waits.
 */
export async function readDatabaseClock(
  source: DatabaseClockSource,
): Promise<Date> {
  const db = 'execute' in source ? source : drizzle(source);
  const clock = await db
    .execute<{ now: string }>(sql`select clock_timestamp() now`)
    .catch(rethrowQueryFailure);
  const now = clock.rows[0]?.now;
  if (now === undefined) throw new Error('Database clock is unavailable');
  return new Date(now);
}
