import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflows,
  workflowDrafts,
  workflowPromotionOrigins,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { WorkflowPromotionPreview } from '@pertexo/contracts';
import {
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';
import { generatePersistedId } from '@pertexo/database/platform';
import { pruneStepSamples } from '../../step-samples/records.repository.js';
import { publishWorkflowDirectly } from '../../publication/publish.js';
import { requestPublicationReview } from '../../reviews/request.repository.js';
import type { PromotionContext, WorkflowPromotionStore } from '../contract.js';
import { promotionDigest } from '../preparation/graph.js';
export async function writePromotedDraft(
  client: PoolClient,
  context: PromotionContext,
  {
    input,
    review,
    workflow,
    promotionId,
  }: Readonly<{
    input: Parameters<WorkflowPromotionStore['apply']>[0];
    review: WorkflowPromotionPreview;
    workflow: WorkflowPromotionPreview['workflows'][number];
    promotionId: string;
  }>,
) {
  const { workspaceId, workflowId, revision } = await persistPromotionCandidate(
    client,
    { input, review, workflow, promotionId },
  );
  const representationTag = workflowDraftRepresentationTag({
    workflowId,
    revision,
    graph: workflow.proposedGraph,
    compatibilityFingerprint: workflowCompatibilityReport(
      workflow.proposedGraph,
      context.catalogs.definitionCatalog,
    ).fingerprint,
  });
  const command = { ...input, workspaceId, workflowId, representationTag };
  let publishedVersionId: string | null = null;
  let versionNumber: number | null = null;
  let publicationRequestId: string | null = null;
  if (input.mode === 'publish') {
    const published = await publishWorkflowDirectly(context, client, command);
    publishedVersionId = published.version.id;
    versionNumber = published.version.versionNumber;
  } else if (input.mode === 'request_approval') {
    const requested = await requestPublicationReview(client, context, {
      ...command,
      idempotencyKey: `${promotionId}:${workflowId}`,
      note: input.note ?? 'Review this promoted workflow.',
    });
    publicationRequestId = requested.id;
  }
  return {
    sourceWorkflowId: workflow.sourceWorkflowId,
    targetWorkflowId: workflowId,
    revision,
    publishedVersionId,
    versionNumber,
    publicationRequestId,
  };
}

async function persistPromotionCandidate(
  client: PoolClient,
  {
    input,
    review,
    workflow,
    promotionId,
  }: Parameters<typeof writePromotedDraft>[2],
) {
  const workspaceId = review.targetWorkspaceId,
    workflowId = workflow.targetWorkflowId ?? generatePersistedId();
  const revision = (workflow.targetRevision ?? 0) + 1,
    db = drizzle(client);
  if (workflow.targetWorkflowId === null) {
    await db
      .insert(workflows)
      .values({
        id: workflowId,
        workspaceId,
        name: workflow.sourceName,
        createdBy: input.actorId,
      })
      .catch(rethrowQueryFailure);
    await db
      .insert(workflowDrafts)
      .values({
        workflowId,
        workspaceId,
        revision: 1,
        graphJson: workflow.proposedGraph,
        updatedBy: input.actorId,
      })
      .catch(rethrowQueryFailure);
  } else {
    await db
      .update(workflowDrafts)
      .set({
        graphJson: workflow.proposedGraph,
        revision,
        updatedBy: input.actorId,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(workflowDrafts.workspaceId, workspaceId),
          eq(workflowDrafts.workflowId, workflowId),
        ),
      )
      .catch(rethrowQueryFailure);
    await db
      .update(workflows)
      .set({
        name: workflow.sourceName,
        nameRevision: sql`${workflows.nameRevision}+case when ${workflows.name}<>${workflow.sourceName}::varchar then 1 else 0 end`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(workflows.workspaceId, workspaceId),
          eq(workflows.id, workflowId),
        ),
      )
      .catch(rethrowQueryFailure);
    await pruneStepSamples(
      client,
      workspaceId,
      workflowId,
      workflow.proposedGraph,
    );
  }
  await db
    .insert(workflowPromotionOrigins)
    .values({
      workspaceId,
      workflowId,
      sourceWorkspaceId: input.workspaceId,
      sourceWorkflowId: workflow.sourceWorkflowId,
      sourceVersionId: workflow.sourceVersionId,
      sourceChecksum: workflow.sourceChecksum,
      graphDigest: promotionDigest(workflow.proposedGraph),
      targetName: workflow.sourceName,
      draftRevision: revision,
      publishedVersionId: workflow.targetPublishedVersionId,
      promotionId,
    })
    .onConflictDoUpdate({
      target: [
        workflowPromotionOrigins.workspaceId,
        workflowPromotionOrigins.workflowId,
      ],
      set: {
        sourceVersionId: sql`excluded.source_version_id`,
        sourceChecksum: sql`excluded.source_checksum`,
        graphDigest: sql`excluded.graph_digest`,
        targetName: sql`excluded.target_name`,
        draftRevision: sql`excluded.draft_revision`,
        publishedVersionId: sql`excluded.published_version_id`,
        promotionId: sql`excluded.promotion_id`,
        appliedAt: sql`clock_timestamp()`,
      },
    })
    .catch(rethrowQueryFailure);
  return { workspaceId, workflowId, revision };
}
