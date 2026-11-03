import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * The time now, not the transaction's start. A flow that waited on a row lock may
 * have crossed an expiry meanwhile, without that row changing.
 */
export async function readDatabaseClock(
  db: Pick<NodePgDatabase, 'execute'>,
): Promise<Date> {
  const clock = await db
    .execute<{ now: string }>(sql`select clock_timestamp() now`)
    .catch(rethrowQueryFailure);
  const now = clock.rows[0]?.now;
  if (now === undefined) throw new Error('Database clock is unavailable');
  return new Date(now);
}
