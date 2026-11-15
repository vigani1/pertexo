import type { Pool, PoolClient } from 'pg';

import { withPlatformTransaction } from '@pertexo/database/platform';

import { setLockTimeout } from './transaction-settings.repository.js';

/** One maintenance transaction with lock and statement timeouts. */
export type RetentionTransactionOptions = Readonly<{
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}>;

/** Work outside a transaction gives up when the caller does or the time is up. */
export function withDeadline(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  return AbortSignal.any([
    ...(signal === undefined ? [] : [signal]),
    AbortSignal.timeout(timeoutMs),
  ]);
}

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
        await setLockTimeout(client, options.lockTimeoutMs);
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
