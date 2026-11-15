import { and, eq, gt } from 'drizzle-orm';
import { idempotencyRecords, previewRuns } from '@pertexo/database/schema';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { PREVIEW_STATUS } from '../../preview-state.js';
import type { AcceptPreviewRunInput } from './preview-acceptance.types.js';

/** The command receipt under this key, joined to the preview it accepted. */
export async function readAcceptanceReceipt(
  transaction: WorkspaceTransaction,
  input: Pick<AcceptPreviewRunInput, 'keyHash' | 'operation' | 'scope'>,
) {
  const rows = await transaction.db
    .select({
      requestHash: idempotencyRecords.requestHash,
      resourceId: idempotencyRecords.resourceId,
      resultRef: idempotencyRecords.resultRef,
      idempotencyStatus: idempotencyRecords.status,
      acceptedAt: previewRuns.createdAt,
      expiresAt: previewRuns.expiresAt,
      previewStatus: previewRuns.status,
      pinnedSampleId: previewRuns.pinnedSampleId,
      outputRef: previewRuns.outputRef,
      completedAt: previewRuns.completedAt,
    })
    .from(idempotencyRecords)
    .leftJoin(
      previewRuns,
      and(
        eq(previewRuns.workspaceId, idempotencyRecords.workspaceId),
        eq(previewRuns.id, idempotencyRecords.resourceId),
      ),
    )
    .where(
      and(
        eq(idempotencyRecords.workspaceId, transaction.workspaceId),
        eq(idempotencyRecords.operation, input.operation),
        eq(idempotencyRecords.scope, input.scope),
        eq(idempotencyRecords.keyHash, input.keyHash),
      ),
    )
    .limit(1);
  return rows[0];
}

/** A live succeeded preview's stored output in the same workflow. */
export async function readPriorPreviewOutput(
  transaction: WorkspaceTransaction,
  workflowId: string,
  previewRunId: string,
  now: Date,
): Promise<unknown> {
  const rows = await transaction.db
    .select({ outputRef: previewRuns.outputRef })
    .from(previewRuns)
    .where(
      and(
        eq(previewRuns.workspaceId, transaction.workspaceId),
        eq(previewRuns.workflowId, workflowId),
        eq(previewRuns.id, previewRunId),
        eq(previewRuns.status, PREVIEW_STATUS.succeeded),
        gt(previewRuns.expiresAt, now),
      ),
    )
    .limit(1);
  return rows[0]?.outputRef;
}
