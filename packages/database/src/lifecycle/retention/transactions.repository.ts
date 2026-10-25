import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { Pool, PoolClient } from 'pg';

import { withPlatformTransaction } from '../../tenant-access/transactions.js';

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
  try {
    return await withPlatformTransaction(
      pool,
      async (client) => {
        await drizzle(client)
          .execute(
            sql`select set_config('lock_timeout',${`${String(options.lockTimeoutMs)}ms`},true)`,
          )
          .catch(rethrowQueryFailure);
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
