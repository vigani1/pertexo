import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { withPlatformTransaction } from '../tenant-access/workspace.js';
import { sha256HexSchema } from '../validation/persisted-primitives.js';

export type RetentionTransactionOptions = Readonly<{
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}>;

function parseLockedRetentionControl(
  row: Readonly<{
    retention_control_hash: string;
    retention_control_sequence: number | string;
  }>,
): Readonly<{ hash: string; sequence: number }> {
  return Object.freeze({
    hash: sha256HexSchema.parse(row.retention_control_hash),
    sequence: z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(row.retention_control_sequence),
  });
}

export async function lockWorkspaceRetentionControl(
  pool: Pool,
  options: RetentionTransactionOptions,
  signal: AbortSignal | undefined,
  workspaceId: string,
  missingRowMessage: string,
): Promise<Readonly<{ hash: string; sequence: number }>> {
  return inRetentionTransaction(pool, options, signal, async (client) => {
    const locked = await client.query<{
      retention_control_hash: string;
      retention_control_sequence: number | string;
    }>({
      text: 'select * from app.lock_workspace_control_ledger($1)',
      values: [workspaceId],
    });
    const row = locked.rows[0];
    if (row === undefined) throw new Error(missingRowMessage);
    return parseLockedRetentionControl(row);
  });
}

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
    // Maintenance runners distinguish their exact lease-loss/shutdown reason.
    // The shared guard owns wire cancellation and destroys the affected client.
    signal?.throwIfAborted();
    throw error;
  }
}
