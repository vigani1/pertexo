import { generatePersistedId } from '@pertexo/database/platform';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowDrafts,
  workflowPromotionOrigins,
  workflows,
} from '@pertexo/database/schema';
import type { WorkflowPromotionPreview } from '@pertexo/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { pruneStepSamples } from '../step-samples/step-sample-state.repository.js';
import { promotionGraphDigest } from './preparation/graph.js';
import type { ApplyPromotionInput } from './workflow-promotion.types.js';

/**
 * Writes the promoted draft into the target workspace: a new workflow, or the
 * linked one's next draft revision and name, and its promotion origin.
 */
export async function persistPromotionCandidate(
  client: PoolClient,
  {
    input,
    review,
    workflow,
    promotionId,
  }: Readonly<{
    input: ApplyPromotionInput;
    review: WorkflowPromotionPreview;
    workflow: WorkflowPromotionPreview['workflows'][number];
    promotionId: string;
  }>,
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
      graphDigest: promotionGraphDigest(workflow.proposedGraph),
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
