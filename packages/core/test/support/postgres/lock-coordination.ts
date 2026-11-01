import { expect } from 'vitest';
import type { Pool, Client } from 'pg';

export function scopedConnectionUrl(
  baseUrl: string,
  databasePath: string,
  applicationName?: string,
): string {
  const url = new URL(baseUrl);
  url.pathname = databasePath;
  if (applicationName !== undefined)
    url.searchParams.set('application_name', applicationName);
  return url.toString();
}

export async function waitForApplicationLock(
  observer: Pool | Client,
  applicationName: string,
): Promise<void> {
  let lastObserved: unknown = null;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await observer.query<{
      blockers: number[];
      pid: number;
    }>(
      `select pid,pg_blocking_pids(pid) blockers
         from pg_stat_activity
        where datname=current_database() and application_name=$1
          and wait_event_type='Lock'`,
      [applicationName],
    );
    lastObserved = result.rows;
    if (result.rows.length === 1 && (result.rows[0]?.blockers.length ?? 0) > 0)
      return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `PostgreSQL application did not enter the expected lock wait: ${JSON.stringify(lastObserved)}`,
  );
}

/** Observes the lock waiter before a test releases its blocking transaction. */
export async function waitForBlockedBy(
  observer: Pool | Client,
  blockerPid: number,
  options: Readonly<{ timeout?: number; minimumWaiters?: number }> = {},
): Promise<void> {
  await expect
    .poll(
      async () => {
        const result = await observer.query<{ waiters: number }>(
          `with recursive blocked(pid) as (
             select $1::int
             union
             select activity.pid from pg_stat_activity activity
               join blocked blocker on blocker.pid=any(pg_blocking_pids(activity.pid))
           ) select (count(*)-1)::int waiters from blocked`,
          [blockerPid],
        );
        return result.rows[0]?.waiters ?? 0;
      },
      { timeout: options.timeout ?? 1_000, interval: 5 },
    )
    .toBeGreaterThanOrEqual(options.minimumWaiters ?? 1);
}
