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
  return new Date(await readDatabaseClockText(source));
}

/**
 * The same reading in UTC with its microseconds (`2026-11-15T10:00:00.123456Z`),
 * for a flow that stores it back into a timestamp column, hands it on as a
 * cursor or compares it at microsecond precision.
 */
export async function readDatabaseClockText(
  source: DatabaseClockSource,
): Promise<string> {
  const db = 'execute' in source ? source : drizzle(source);
  const clock = await db
    .execute<{ now: string }>(
      sql`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') now`,
    )
    .catch(rethrowQueryFailure);
  const now = clock.rows[0]?.now;
  if (now === undefined) throw new Error('Database clock is unavailable');
  return now;
}

/** A clock reading's seconds since the epoch, keeping its microseconds. */
export function databaseClockEpochSeconds(reading: string): number {
  const [whole, fraction = '0'] = reading.slice(0, -1).split('.');
  return Number(`${String(Date.parse(`${whole ?? ''}Z`) / 1_000)}.${fraction}`);
}
