import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { Pool, PoolClient } from 'pg';

import { withPlatformTransaction } from '@pertexo/database/platform';

/** One maintenance transaction with lock and statement timeouts. */
export type RetentionTransactionOptions = Readonly<{
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}>;

/** Writes and counters in a maintenance transaction belong to this workspace. */
export async function scopeToWorkspace(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await drizzle(client)
    .execute(sql`select set_config('app.workspace_id',${workspaceId},true)`)
    .catch(rethrowQueryFailure);
}

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
