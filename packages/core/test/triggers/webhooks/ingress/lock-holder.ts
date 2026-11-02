import type { Pool, QueryResultRow } from 'pg';
import { expect } from 'vitest';

/**
 * Another connection with a transaction left open, so a test decides exactly when
 * what it did becomes visible and when the locks it took are let go.
 */
export async function openTransaction(
  pool: Pool,
  observer: Pool,
  workspaceId: string,
  { role }: Readonly<{ role: string | undefined }>,
) {
  const client = await pool.connect();
  await client.query('begin');
  if (role !== undefined) await client.query(`set local role ${role}`);
  await client.query("select set_config('app.workspace_id',$1,true)", [
    workspaceId,
  ]);
  const { rows } = await client.query<{ pid: number }>(
    'select pg_backend_pid() pid',
  );
  const pid = rows[0]?.pid;
  let open = true;
  const finish = async (statement: 'commit' | 'rollback') => {
    if (!open) return;
    open = false;
    await client.query(statement);
    client.release();
  };
  return {
    query: <Row extends QueryResultRow = QueryResultRow>(
      statement: string,
      parameters: unknown[] = [],
    ) => client.query<Row>(statement, parameters),
    /** What is stuck behind this transaction right now, as the database sees it. */
    waiters: async () => {
      const { rows: waiting } = await observer.query<{ query: string }>(
        `select query from pg_stat_activity
          where wait_event_type='Lock' and pg_blocking_pids(pid) @> array[$1::int]`,
        [pid],
      );
      return waiting.map(({ query }) => query);
    },
    commit: () => finish('commit'),
    rollback: () => finish('rollback'),
  };
}

export type OpenTransaction = Awaited<ReturnType<typeof openTransaction>>;

/** Returns the statement that is stuck, once something matching it really is. */
export async function waitForWaiter(
  holder: OpenTransaction,
  statement: RegExp,
): Promise<void> {
  await expect
    .poll(
      async () => (await holder.waiters()).some((text) => statement.test(text)),
      { timeout: 10_000, interval: 10 },
    )
    .toBe(true);
}

/** Every SQLSTATE in an error and its causes. */
export function sqlStates(error: unknown): string[] {
  const states: string[] = [];
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') states.push(code);
    current = cause;
  }
  return states;
}
