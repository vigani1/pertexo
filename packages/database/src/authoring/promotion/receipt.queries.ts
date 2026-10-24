import type { WorkflowPromotionResult } from '@pertexo/contracts';
import { PROMOTION_LIMITS } from '@pertexo/workflow-model';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { auditEvents } from '../../schema/foundation.js';
import { workflows } from '../../schema/authoring/workflows.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { WorkspaceScopeRunner } from '../../tenant-access/transactions.js';
import { readFolderScope } from '../../tenant-access/resources/facts.queries.js';
import { workflowScopeSql } from '../../tenant-access/resources/scope.queries.js';
import type { PromotionScope } from './contract.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import { WorkflowPromotionError } from './errors.js';

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
  const scope = await readFolderScope(client, { workspaceId, actorId });
  const rows = await drizzle(client)
    .select({
      metadata: sql<
        Omit<WorkflowPromotionResult['items'][number], 'publishedVersionId'> & {
          targetVersionId: string | null;
        }
      >`${auditEvents.metadata}`,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.workspaceId, workspaceId),
        workflowScopeSql(scope, sql`${auditEvents.targetId}`),
        eq(auditEvents.action, 'workflow.promotion_sent'),
        inArray(auditEvents.targetId, [...workflowIds]),
        sql`${auditEvents.metadata}->>'promotionId'=${receipt.promotionId}`,
      ),
    )
    .orderBy(asc(auditEvents.id))
    .limit(PROMOTION_LIMITS.workflows + 1)
    .catch(rethrowQueryFailure);
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
      const found = await drizzle(client)
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          and(
            eq(workflows.workspaceId, receipt.targetWorkspaceId),
            inArray(
              workflows.id,
              result.items.map((item) => item.targetWorkflowId),
            ),
            workflowScopeSql(scope, sql`${workflows.id}`, 'workflow:update'),
          ),
        )
        .catch(rethrowQueryFailure);
      if (found.length !== result.items.length)
        throw new WorkflowPromotionError(
          'unavailable',
          'The target workflow is unavailable.',
        );
    },
  );
  return result;
}
