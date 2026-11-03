import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import {
  workflows,
  workflowDrafts,
  workflowPromotionOrigins,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

export function readTargetOrigin(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    sourceWorkspaceId: string;
    sourceWorkflowId: string;
  }>,
) {
  const origin = workflowPromotionOrigins;
  return drizzle(client)
    .select({
      workflow_id: origin.workflowId,
      graph_digest: origin.graphDigest,
      target_name: origin.targetName,
      draft_revision: origin.draftRevision,
      published_version_id: origin.publishedVersionId,
      promotion_id: origin.promotionId,
    })
    .from(origin)
    .where(
      and(
        eq(origin.workspaceId, input.workspaceId),
        eq(origin.sourceWorkspaceId, input.sourceWorkspaceId),
        eq(origin.sourceWorkflowId, input.sourceWorkflowId),
      ),
    )
    .catch(rethrowQueryFailure);
}
export type Origin = Awaited<ReturnType<typeof readTargetOrigin>>[number];

export function lockTargetWorkflow(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; workflowId: string }>,
) {
  const workflow = alias(workflows, 'workflow'),
    draft = alias(workflowDrafts, 'draft');
  return drizzle(client)
    .select({
      name: workflow.name,
      published_version_id: workflow.publishedVersionId,
      lifecycle_status: workflow.lifecycleStatus,
      revision: draft.revision,
      graph_json: draft.graphJson,
    })
    .from(workflow)
    .innerJoin(
      draft,
      and(
        eq(draft.workspaceId, workflow.workspaceId),
        eq(draft.workflowId, workflow.id),
      ),
    )
    .where(
      and(
        eq(workflow.workspaceId, input.workspaceId),
        eq(workflow.id, input.workflowId),
      ),
    )
    .for('update', { of: [workflow, draft] })
    .catch(rethrowQueryFailure);
}
export type TargetWorkflowRow = Awaited<
  ReturnType<typeof lockTargetWorkflow>
>[number];
