import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

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
      ...(signal === undefined ? {} : { signal }),
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
