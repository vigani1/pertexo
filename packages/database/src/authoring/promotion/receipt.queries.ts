import type { WorkflowPromotionResult } from '@pertexo/contracts';
import { PROMOTION_LIMITS } from '@pertexo/workflow-model';
import { sql } from 'drizzle-orm';
import type { WorkspaceScopeRunner } from '../../tenant-access/transactions.js';
import { readFolderScope } from '../../tenant-access/resources/facts.queries.js';
import {
  bindResourcePredicate,
  workflowScopeSql,
} from '../../tenant-access/resources/scope.queries.js';
import type { PromotionScope } from './contract.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import { WorkflowPromotionError } from './contract.js';

/** Audit facts outlive the command's 24-hour retry window (minimum retention: 30 days). */
export const promotionReceiptSchema = z
  .object({ promotionId: z.uuid(), targetWorkspaceId: z.uuid() })
  .strict();
async function readPromotionReceipt(
  client: PoolClient,
  workspaceId: string,
  {
    actorId,
    receipt,
    workflowIds,
  }: Readonly<{
    actorId: string;
    receipt: z.output<typeof promotionReceiptSchema>;
    workflowIds: readonly string[];
  }>,
) {
  const parameters: unknown[] = [
    workspaceId,
    workflowIds,
    receipt.promotionId,
    PROMOTION_LIMITS.workflows + 1,
  ];
  const scope = await readFolderScope(client, { workspaceId, actorId });
  const visible = bindResourcePredicate(
    workflowScopeSql(scope, sql`target_id`),
    parameters,
  );
  const rows = (
    await client.query<{
      metadata: Omit<
        WorkflowPromotionResult['items'][number],
        'publishedVersionId'
      > & {
        targetVersionId: string | null;
      };
    }>(
      `select metadata from app.audit_events where workspace_id=$1 and ${visible} and action='workflow.promotion_sent' and target_id=any($2::uuid[]) and metadata->>'promotionId'=$3 order by id limit $4`,
      parameters,
    )
  ).rows;
  if (rows.length !== workflowIds.length)
    throw new WorkflowPromotionError(
      'unavailable',
      'This promotion receipt is no longer available. Inspect the target before starting another promotion.',
    );
  return {
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
  };
}

export async function readAuthorizedPromotionReceipt(
  inWorkspace: WorkspaceScopeRunner,
  input: PromotionScope,
  receipt: z.output<typeof promotionReceiptSchema>,
  workflowIds: readonly string[],
) {
  const result = await inWorkspace(input, (client) =>
    readPromotionReceipt(client, input.workspaceId, {
      actorId: input.actorId,
      receipt,
      workflowIds,
    }),
  );
  await inWorkspace(
    { workspaceId: receipt.targetWorkspaceId, actorId: input.actorId },
    async (client) => {
      const scope = await readFolderScope(client, {
        workspaceId: receipt.targetWorkspaceId,
        actorId: input.actorId,
      });
      const parameters: unknown[] = [
        receipt.targetWorkspaceId,
        result.items.map((item) => item.targetWorkflowId),
      ];
      const visible = bindResourcePredicate(
        workflowScopeSql(scope, sql`id`, 'workflow:update'),
        parameters,
      );
      const found = await client.query(
        `select id from app.workflows where workspace_id=$1 and id=any($2::uuid[]) and ${visible}`,
        parameters,
      );
      if (found.rows.length !== result.items.length)
        throw new WorkflowPromotionError(
          'unavailable',
          'The target workflow is unavailable.',
        );
    },
  );
  return result;
}
