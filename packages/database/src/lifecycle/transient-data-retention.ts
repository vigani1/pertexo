import type { Pool } from 'pg';
import { z } from 'zod';

import { inRetentionTransaction } from './retention-transaction.js';
import type { ParsedRetentionDatabaseOptions } from './retention-support.js';

export type TransientDataReapResult = Readonly<{
  idempotencyRecordsDeleted: number;
  sessionsDeleted: number;
  workspaceCreationRecordsDeleted: number;
}>;

const deletedCountSchema = z.coerce.number().int().nonnegative();

export async function reapTransientData(
  pool: Pool,
  options: ParsedRetentionDatabaseOptions,
  signal?: AbortSignal,
): Promise<TransientDataReapResult> {
  return inRetentionTransaction(pool, options, signal, async (client) => {
    const result = await client.query<{
      idempotency_records_deleted: number;
      sessions_deleted: number;
      workspace_creation_records_deleted: number;
    }>({
      text: 'select * from app.reap_transient_data($1)',
      values: [options.pageSize],
    });
    const row = result.rows[0];
    if (row === undefined)
      throw new Error('Transient-data reaper result was not returned');
    return Object.freeze({
      idempotencyRecordsDeleted: deletedCountSchema.parse(
        row.idempotency_records_deleted,
      ),
      sessionsDeleted: deletedCountSchema.parse(row.sessions_deleted),
      workspaceCreationRecordsDeleted: deletedCountSchema.parse(
        row.workspace_creation_records_deleted,
      ),
    });
  });
}
