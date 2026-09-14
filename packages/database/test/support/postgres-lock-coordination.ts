import type { Pool } from 'pg';

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
  observer: Pool,
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
