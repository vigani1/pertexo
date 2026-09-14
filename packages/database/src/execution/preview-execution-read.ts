import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';

import {
  assertPreviewActor,
  PREVIEW_STATUS,
  type PreviewRunRecord,
  type PreviewStatus,
} from './preview-execution-acceptance.js';
import { parseStoredExecutionValueV1 } from './stored-execution-value.js';
import { previewRuns } from '../schema.js';
import type { WorkspaceTransaction } from '../tenant-access/workspace.js';

const previewStatusSchema = z.enum(
  Object.values(PREVIEW_STATUS) as [PreviewStatus, ...PreviewStatus[]],
);

export async function readPreviewRun(
  transaction: WorkspaceTransaction,
  input: Readonly<{ actorUserId: string; previewRunId: string }>,
  now: Date = new Date(),
): Promise<PreviewRunRecord | null> {
  const actorUserId = z.uuid().parse(input.actorUserId);
  const previewRunId = z.uuid().parse(input.previewRunId);
  await assertPreviewActor(transaction, actorUserId);
  const rows = await transaction.db
    .select({
      completedAt: previewRuns.completedAt,
      createdAt: previewRuns.createdAt,
      draftRevision: previewRuns.draftRevision,
      dryRun: previewRuns.dryRun,
      expiresAt: previewRuns.expiresAt,
      id: previewRuns.id,
      mayContactProvider: previewRuns.mayContactProvider,
      mayCauseExternalSideEffect: previewRuns.mayCauseExternalSideEffect,
      nodeId: previewRuns.nodeId,
      outputRef: previewRuns.outputRef,
      safeErrorCode: previewRuns.safeErrorCode,
      sideEffectClass: previewRuns.sideEffectClass,
      startedAt: previewRuns.startedAt,
      status: previewRuns.status,
      workflowId: previewRuns.workflowId,
      workspaceId: previewRuns.workspaceId,
    })
    .from(previewRuns)
    .where(
      and(
        eq(previewRuns.workspaceId, transaction.workspaceId),
        eq(previewRuns.id, previewRunId),
        gt(previewRuns.expiresAt, now),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    workflowId: row.workflowId,
    draftRevision: row.draftRevision,
    nodeId: row.nodeId,
    status: previewStatusSchema.parse(row.status),
    sideEffectClass: z
      .enum(['safe', 'idempotent_with_key', 'unsafe'])
      .parse(row.sideEffectClass),
    mayContactProvider: row.mayContactProvider,
    mayCauseExternalSideEffect: row.mayCauseExternalSideEffect,
    dryRun: z.enum(['not_supported', 'provider_supported']).parse(row.dryRun),
    output:
      row.outputRef === null
        ? null
        : parseStoredExecutionValueV1(row.outputRef),
    safeErrorCode: row.safeErrorCode,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    expiresAt: row.expiresAt,
  });
}
