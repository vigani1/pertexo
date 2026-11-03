import { Client, type Pool } from 'pg';
import { expect } from 'vitest';

/** Observe the actual lock dependency before advancing a concurrent request. */
export async function waitForDatabaseBlock(
  pool: Pool,
  blockerPid: number,
  queryPart = '',
) {
  await expect
    .poll(
      async () =>
        (
          await pool.query<{ blocked: boolean }>(
            `select exists(select 1 from pg_stat_activity where datname=current_database()
      and $1=any(pg_blocking_pids(pid)) and query like '%' || $2 || '%') blocked`,
            [blockerPid, queryPart],
          )
        ).rows[0]?.blocked,
    )
    .toBe(true);
}

export async function databaseBarrier(pool: Pool) {
  const holder = new Client({
    connectionString: pool.options.connectionString,
  });
  await holder.connect();
  await holder.query('begin');
  const pid = (
    await holder.query<{ pid: number }>('select pg_backend_pid() pid')
  ).rows[0]?.pid;
  if (pid === undefined) throw new Error('Barrier connection missing');
  return {
    holder,
    pid,
    async close() {
      await holder.query('rollback');
      await holder.end();
    },
  };
}
