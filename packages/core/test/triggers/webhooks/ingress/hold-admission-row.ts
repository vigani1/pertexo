import type { Pool } from 'pg';

/** Another writer sitting on the workspace's admission row, which every acceptance needs. */
export async function holdAdmissionRow(pool: Pool, workspaceId: string) {
  const client = await pool.connect();
  await client.query('begin');
  await client.query('set local role pertexo_owner');
  await client.query("select set_config('app.workspace_id',$1,true)", [
    workspaceId,
  ]);
  await client.query(
    'select 1 from app.workspace_execution_admission_counters where workspace_id=$1 for update',
    [workspaceId],
  );
  const { rows } = await client.query<{ pid: number }>(
    'select pg_backend_pid() pid',
  );
  const holder = rows[0]?.pid;
  return {
    /** How many transactions are stuck right behind this writer. */
    blocked: async () => {
      const { rows: waiting } = await client.query<{ count: number }>(
        `select count(distinct pid)::int count from pg_locks
          where not granted and pg_blocking_pids(pid) @> array[$1::int]`,
        [holder],
      );
      return waiting[0]?.count ?? 0;
    },
    release: async () => {
      await client.query('commit');
      client.release();
    },
  };
}
