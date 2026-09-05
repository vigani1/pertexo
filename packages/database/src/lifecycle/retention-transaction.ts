import type { Pool, PoolClient } from 'pg';

export type RetentionTransactionOptions = Readonly<{
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}>;

export async function inRetentionTransaction<T>(
  pool: Pool,
  options: RetentionTransactionOptions,
  signal: AbortSignal | undefined,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let committed = false;
  try {
    signal?.throwIfAborted();
    await client.query('begin');
    await client.query({
      ...(signal === undefined ? {} : { signal }),
      text: `set local lock_timeout='${String(options.lockTimeoutMs)}ms';
             set local statement_timeout='${String(options.statementTimeoutMs)}ms'`,
    });
    const result = await work(client);
    signal?.throwIfAborted();
    await client.query('commit');
    committed = true;
    return result;
  } catch (error: unknown) {
    if (!committed) await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release(!committed);
  }
}
