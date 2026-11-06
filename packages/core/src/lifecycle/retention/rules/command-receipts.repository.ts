import {
  idempotencyRecords,
  workspaceCreationIdempotencyRecords,
  workflowManualStartRejections,
} from '@pertexo/database/schema';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { deletionRule } from '../../../shared/retention-deletion.js';

// A command's stored result answers retries until its key expires.
export const commandReceipts = deletionRule('idempotency_records', {
  table: idempotencyRecords,
  keys: [idempotencyRecords.id],
  condition: and(
    eq(idempotencyRecords.status, 'completed'),
    lte(idempotencyRecords.expiresAt, sql`clock_timestamp()`),
  ),
  orderBy: [idempotencyRecords.expiresAt, idempotencyRecords.id],
});

export const creationReceipts = deletionRule('workspace_creation_records', {
  table: workspaceCreationIdempotencyRecords,
  keys: [workspaceCreationIdempotencyRecords.id],
  condition: and(
    inArray(workspaceCreationIdempotencyRecords.status, [
      'completed',
      'failed',
    ]),
    lte(workspaceCreationIdempotencyRecords.expiresAt, sql`clock_timestamp()`),
  ),
  orderBy: [
    workspaceCreationIdempotencyRecords.expiresAt,
    workspaceCreationIdempotencyRecords.id,
  ],
});

export const startRejections = deletionRule('manual_start_rejections', {
  table: workflowManualStartRejections,
  keys: [
    workflowManualStartRejections.workspaceId,
    workflowManualStartRejections.scope,
    workflowManualStartRejections.keyHash,
  ],
  condition: lte(
    workflowManualStartRejections.expiresAt,
    sql`clock_timestamp()`,
  ),
  orderBy: [workflowManualStartRejections.expiresAt],
});
