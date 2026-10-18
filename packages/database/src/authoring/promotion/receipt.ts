import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  PROMOTION_LIMITS,
  workflowPromotionResultSchema,
} from '@pertexo/contracts';
import { WorkflowPromotionError } from './contract.js';

/** Audit facts outlive the command's 24-hour retry window (minimum retention: 30 days). */
export const promotionReceiptSchema = z
  .object({ promotionId: z.uuid(), targetWorkspaceId: z.uuid() })
  .strict();
export async function readPromotionReceipt(
  client: PoolClient,
  workspaceId: string,
  receipt: z.output<typeof promotionReceiptSchema>,
  workflowIds: readonly string[],
) {
  const rows = (
    await client.query<{ metadata: Record<string, unknown> }>(
      `select metadata from app.audit_events where workspace_id=$1 and action='workflow.promotion_sent' and target_id=any($2::uuid[]) and metadata->>'promotionId'=$3 order by id limit $4`,
      [
        workspaceId,
        workflowIds,
        receipt.promotionId,
        PROMOTION_LIMITS.workflows + 1,
      ],
    )
  ).rows;
  if (rows.length !== workflowIds.length)
    throw new WorkflowPromotionError(
      'unavailable',
      'This promotion receipt is no longer available. Inspect the target before starting another promotion.',
    );
  return workflowPromotionResultSchema.parse({
    promotionId: receipt.promotionId,
    sourceWorkspaceId: workspaceId,
    targetWorkspaceId: receipt.targetWorkspaceId,
    replayed: true,
    items: rows.map(({ metadata }) => ({
      sourceWorkflowId: metadata.sourceWorkflowId,
      targetWorkflowId: metadata.targetWorkflowId,
      revision: metadata.revision,
      publishedVersionId: metadata.targetVersionId,
      versionNumber: metadata.versionNumber,
      publicationRequestId: metadata.publicationRequestId,
    })),
  });
}
