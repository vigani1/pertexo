import type { Pool, PoolClient, QueryResult } from 'pg';
import { z } from 'zod';

import type {
  RetentionDatabaseOptions,
  RetentionDryRunClaim,
} from './retention-contracts.js';

export const retentionUuidSchema = z.uuid();
export const retentionBoundedText = (maximum: number) =>
  z.string().trim().min(1).max(maximum);
export const retentionDateSchema = z
  .date()
  .refine((value) => Number.isFinite(value.getTime()));
export const retentionKindSchema = z.enum([
  'workflow_run_input',
  'execution_detail',
  'run_summary',
  'trigger_summary',
  'audit_security',
]);

const retentionTupleSchema = z
  .object({
    type: z.enum([
      'timestamp_uuid',
      'timestamp_uuid_text_text',
      'uuid',
      'uuid_bigint',
    ]),
    values: z.array(z.union([z.string(), z.number()])),
  })
  .strict();

export const retentionOptionsSchema = z
  .object({
    leaseOwner: retentionBoundedText(128),
    leaseSeconds: z.number().int().min(1).max(300).default(300),
    maxPagesPerBatch: z.number().int().min(1).max(10_000).default(1_000),
    pageSize: z.number().int().min(1).max(1_000).default(100),
  })
  .strict();

export type ParsedRetentionDatabaseOptions = z.output<
  typeof retentionOptionsSchema
>;

export function retentionQuery<Row extends Record<string, unknown>>(
  pool: Pool | PoolClient,
  text: string,
  values: readonly unknown[],
  signal?: AbortSignal,
): Promise<QueryResult<Row>> {
  signal?.throwIfAborted();
  return pool.query<Row>({
    text,
    values: [...values],
    ...(signal === undefined ? {} : { signal }),
  });
}

export function mapRetentionDryRunClaim(
  row: Record<string, unknown>,
): RetentionDryRunClaim {
  return Object.freeze({
    batchId: retentionUuidSchema.parse(row.batch_id),
    workspaceId: retentionUuidSchema.parse(row.workspace_id),
    retentionKind: retentionKindSchema.parse(row.retention_kind),
    cutoffAt: z.coerce.date().parse(row.cutoff_at),
    requestedBy: retentionBoundedText(128).parse(row.requested_by),
    reason: retentionBoundedText(512).parse(row.reason),
    cursorExpiresAt:
      row.cursor_expires_at === null
        ? null
        : z.coerce.date().parse(row.cursor_expires_at),
    cursorId:
      row.cursor_id === null ? null : retentionUuidSchema.parse(row.cursor_id),
    dryRunCursor:
      row.dry_run_cursor === null || row.dry_run_cursor === undefined
        ? null
        : retentionTupleSchema.parse(row.dry_run_cursor),
    dryRunUpper:
      row.dry_run_upper === null || row.dry_run_upper === undefined
        ? null
        : retentionTupleSchema.parse(row.dry_run_upper),
    leaseToken: retentionUuidSchema.parse(row.lease_token),
    leaseFence: z.coerce.number().int().positive().parse(row.lease_fence),
    leaseExpiresAt: z.coerce.date().parse(row.lease_expires_at),
  });
}

export function parseRetentionDatabaseOptions(
  options: RetentionDatabaseOptions,
): ParsedRetentionDatabaseOptions {
  return retentionOptionsSchema.parse(options);
}
