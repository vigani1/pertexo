import type { WorkflowPromotionHistory } from '@pertexo/contracts';
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflows,
  workflowVersions,
} from '../../schema/authoring/workflows.js';
import { auditEvents, users } from '../../schema/foundation.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { readBrowsableFolderScope } from '../../tenant-access/resources/facts.queries.js';
import { workflowScopeSql } from '../../tenant-access/resources/scope.queries.js';

import { requirePromotionAuthority } from './authority.queries.js';
import type { PromotionContext, WorkflowPromotionStore } from './contract.js';

export function promotionReads(
  context: PromotionContext,
): Pick<WorkflowPromotionStore, 'candidates' | 'history'> {
  return {
    candidates: (input) => readPromotionCandidates(context, input),
    history: (input) => readPromotionHistory(context, input),
  };
}
function readPromotionCandidates(
  context: PromotionContext,
  input: Parameters<WorkflowPromotionStore['candidates']>[0],
): ReturnType<WorkflowPromotionStore['candidates']> {
  return context.transact(
    input.workspaceId,
    input.actorId,
    async (client) => {
      await requirePromotionAuthority(client, input, 'workflow:update', {
        browsing: true,
      });
      const resources = await readBrowsableFolderScope(client, input);
      if (input.workflowId !== undefined) {
        const result = await drizzle(client)
          .select({
            workflowId: workflowVersions.workflowId,
            name: workflows.name,
            versionId: workflowVersions.id,
            versionNumber: workflowVersions.versionNumber,
          })
          .from(workflowVersions)
          .innerJoin(
            workflows,
            and(
              eq(workflows.workspaceId, workflowVersions.workspaceId),
              eq(workflows.id, workflowVersions.workflowId),
            ),
          )
          .where(
            and(
              eq(workflowVersions.workspaceId, input.workspaceId),
              eq(workflowVersions.workflowId, input.workflowId),
              workflowScopeSql(resources, sql`${workflows.id}`),
              eq(workflows.lifecycleStatus, 'active'),
              input.beforeVersionNumber === undefined
                ? undefined
                : lt(workflowVersions.versionNumber, input.beforeVersionNumber),
            ),
          )
          .orderBy(desc(workflowVersions.versionNumber))
          .limit(input.limit + 1)
          .catch(rethrowQueryFailure);
        const rows = result.slice(0, input.limit);
        return {
          items: rows,
          nextCursor: null,
          nextVersionNumber:
            result.length > input.limit
              ? (rows.at(-1)?.versionNumber ?? null)
              : null,
        };
      }

      const result = await drizzle(client)
        .select({
          workflowId: workflows.id,
          name: workflows.name,
          versionId: workflowVersions.id,
          versionNumber: workflowVersions.versionNumber,
        })
        .from(workflows)
        .innerJoin(
          workflowVersions,
          and(
            eq(workflowVersions.workspaceId, workflows.workspaceId),
            eq(workflowVersions.workflowId, workflows.id),
            eq(workflowVersions.id, workflows.publishedVersionId),
          ),
        )
        .where(
          and(
            eq(workflows.workspaceId, input.workspaceId),
            workflowScopeSql(resources, sql`${workflows.id}`),
            eq(workflows.lifecycleStatus, 'active'),
            input.after === undefined
              ? undefined
              : gt(workflows.id, input.after),
            input.search === undefined
              ? undefined
              : sql`position(lower(${input.search}) in lower(${workflows.name}))>0`,
          ),
        )
        .orderBy(asc(workflows.id))
        .limit(input.limit + 1)
        .catch(rethrowQueryFailure);
      const page = result.slice(0, input.limit);
      return {
        nextVersionNumber: null,
        items: page,
        nextCursor:
          result.length > input.limit
            ? (page.at(-1)?.workflowId ?? null)
            : null,
      };
    },
    input.signal,
  );
}
function readPromotionHistory(
  context: PromotionContext,
  input: Parameters<WorkflowPromotionStore['history']>[0],
): ReturnType<WorkflowPromotionStore['history']> {
  return context.transact(
    input.workspaceId,
    input.actorId,
    async (client) => {
      await requirePromotionAuthority(client, input, 'workflow:update', {
        browsing: true,
      });
      const resources = await readBrowsableFolderScope(client, input);
      const result = await drizzle(client)
        .select({
          id: auditEvents.id,
          actorId: auditEvents.actorUserId,
          actorName: sql<string>`coalesce(${users.displayName},'Former member')`,
          occurredAt: auditEvents.occurredAt,
          // These two promotion audit actions always record a workflow target.
          workflowId: sql<string>`${auditEvents.targetId}`,
          metadata: sql<
            Omit<
              WorkflowPromotionHistory['items'][number],
              'id' | 'occurredAt' | 'actorId' | 'actorName' | 'workflowId'
            >
          >`${auditEvents.metadata}`,
        })
        .from(auditEvents)
        .leftJoin(users, eq(users.id, auditEvents.actorUserId))
        .where(
          and(
            eq(auditEvents.workspaceId, input.workspaceId),
            workflowScopeSql(resources, sql`${auditEvents.targetId}`),
            inArray(auditEvents.action, [
              'workflow.promoted',
              'workflow.promotion_sent',
            ]),
            input.after === undefined
              ? undefined
              : lt(auditEvents.id, input.after),
          ),
        )
        .orderBy(desc(auditEvents.id))
        .limit(input.limit + 1)
        .catch(rethrowQueryFailure);
      const items = result.slice(0, input.limit).map((row) => ({
        id: row.id,
        promotionId: row.metadata.promotionId,
        occurredAt: row.occurredAt.toISOString(),
        actorId: row.actorId,
        actorName: row.actorName,
        workflowId: row.workflowId,
        workflowName: row.metadata.workflowName,
        sourceWorkspaceId: row.metadata.sourceWorkspaceId,
        sourceWorkflowId: row.metadata.sourceWorkflowId,
        sourceVersionId: row.metadata.sourceVersionId,
        targetWorkspaceId: row.metadata.targetWorkspaceId,
        targetWorkflowId: row.metadata.targetWorkflowId,
        targetVersionId: row.metadata.targetVersionId,
        publicationRequestId: row.metadata.publicationRequestId,
        mode: row.metadata.mode,
      }));
      return {
        items,
        nextCursor:
          result.length > input.limit ? (items.at(-1)?.id ?? null) : null,
      };
    },
    input.signal,
  );
}
