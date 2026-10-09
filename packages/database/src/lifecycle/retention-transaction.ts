import type { Pool, PoolClient } from 'pg';

import { withPlatformTransaction } from '../tenant-access/workspace.js';

/** One maintenance transaction with lock and statement timeouts. */
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
  if (
    !Number.isSafeInteger(options.lockTimeoutMs) ||
    options.lockTimeoutMs < 1 ||
    options.lockTimeoutMs > 2_147_483_647
  ) {
    throw new RangeError('Invalid PostgreSQL lock timeout');
  }
  try {
    return await withPlatformTransaction(
      pool,
      async (client) => {
        await client.query("select set_config('lock_timeout', $1, true)", [
          `${String(options.lockTimeoutMs)}ms`,
        ]);
        const result = await work(client);
        signal?.throwIfAborted();
        return result;
      },
      {
        ...(signal === undefined ? {} : { signal }),
        statementTimeoutMillis: options.statementTimeoutMs,
      },
    );
  } catch (error: unknown) {
    // Callers see their own abort reason; the shared guard owns wire
    // cancellation and destroys the affected client.
    signal?.throwIfAborted();
    throw error;
  }
}
