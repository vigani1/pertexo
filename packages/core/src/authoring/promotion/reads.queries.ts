import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import type {
  WorkflowPromotionCandidates,
  WorkflowPromotionHistory,
} from '@pertexo/contracts';
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflows,
  workflowVersions,
  auditEvents,
  users,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { readFolderScope } from '../../shared/facts.queries.js';
import { workflowScopeSql } from '../../shared/scope.queries.js';

import type {
  PromotionCandidatesInput,
  PromotionContext,
  PromotionHistoryInput,
} from './contract.js';

// These took the locks by hand, so they stay `change`.
const BROWSE_AS_EDITOR = {
  mode: 'change',
  capability: 'workflow:update',
  statuses: BROWSABLE_WORKSPACE_STATUSES,
} as const;

export function promotionReads(context: PromotionContext) {
  return {
    candidates: (input: PromotionCandidatesInput) =>
      readPromotionCandidates(context, input),
    history: (input: PromotionHistoryInput) =>
      readPromotionHistory(context, input),
  };
}
function readPromotionCandidates(
  context: PromotionContext,
  input: PromotionCandidatesInput,
): Promise<WorkflowPromotionCandidates> {
  return context.access.member(
    input,
    BROWSE_AS_EDITOR,
    async (client, role) => {
      const resources = await readFolderScope(client, input, role);
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
  );
}
function readPromotionHistory(
  context: PromotionContext,
  input: PromotionHistoryInput,
): Promise<WorkflowPromotionHistory> {
  return context.access.member(
    input,
    BROWSE_AS_EDITOR,
    async (client, role) => {
      const resources = await readFolderScope(client, input, role);
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
  );
}
