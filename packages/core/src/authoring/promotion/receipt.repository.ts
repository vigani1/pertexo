import type { FolderScope } from '../../shared/access/folder-access.types.js';

import type { WorkflowPromotionResult } from '@pertexo/contracts';

import { PROMOTION_LIMITS } from '@pertexo/workflow-model';

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { drizzle } from 'drizzle-orm/node-postgres';

import { auditEvents, workflows } from '@pertexo/database/schema';

import { rethrowQueryFailure } from '@pertexo/database/primitives';

import { workflowScopeSql } from '../../shared/access/folder-scope.repository.js';

import type { PoolClient } from 'pg';

import { z } from 'zod';

/** Audit facts outlive the command's 24-hour retry window (minimum retention: 30 days). */
export const promotionReceiptSchema = z
  .object({ promotionId: z.uuid(), targetWorkspaceId: z.uuid() })
  .strict();

/** The source's audit facts for this promotion, one past the workflow cap. */
export async function readPromotionAudit(
  client: PoolClient,
  workspaceId: string,
  {
    scope,
    promotionId,
    workflowIds,
  }: Readonly<{
    scope: FolderScope;
    promotionId: string;
    workflowIds: readonly string[];
  }>,
) {
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
        sql`${auditEvents.metadata}->>'promotionId'=${promotionId}`,
      ),
    )
    .orderBy(asc(auditEvents.id))
    .limit(PROMOTION_LIMITS.workflows + 1)
    .catch(rethrowQueryFailure);
  return rows;
}

/** How many of the target workflows the actor may update. */
export async function countUpdatableWorkflows(
  client: PoolClient,
  workspaceId: string,
  scope: FolderScope,
  workflowIds: readonly string[],
): Promise<number> {
  const found = await drizzle(client)
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, workspaceId),
        inArray(workflows.id, [...workflowIds]),
        workflowScopeSql(scope, sql`${workflows.id}`, 'workflow:update'),
      ),
    )
    .catch(rethrowQueryFailure);
  return found.length;
}
