import type { PoolClient } from 'pg';
import type { WorkflowPromotionPreview } from '@pertexo/contracts';
import {
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import { pruneStepSamples } from '../../step-samples/records.repository.js';
import { publishWorkflowDirectly } from '../../publication/publisher.repository.js';
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
  const workspaceId = review.targetWorkspaceId;
  const workflowId = workflow.targetWorkflowId ?? generatePersistedId();
  const revision = (workflow.targetRevision ?? 0) + 1;
  if (workflow.targetWorkflowId === null) {
    await client.query(
      `insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,$3,$4)`,
      [workflowId, workspaceId, workflow.sourceName, input.actorId],
    );
    await client.query(
      'insert into app.workflow_drafts(workflow_id,workspace_id,revision,graph_json,updated_by) values($1,$2,1,$3::json,$4)',
      [
        workflowId,
        workspaceId,
        JSON.stringify(workflow.proposedGraph),
        input.actorId,
      ],
    );
  } else {
    await client.query(
      'update app.workflow_drafts set graph_json=$3::json,revision=$4,updated_by=$5,updated_at=clock_timestamp() where workspace_id=$1 and workflow_id=$2',
      [
        workspaceId,
        workflowId,
        JSON.stringify(workflow.proposedGraph),
        revision,
        input.actorId,
      ],
    );
    await client.query(
      'update app.workflows set name=$3::varchar,name_revision=name_revision+case when name<>$3::varchar then 1 else 0 end,updated_at=clock_timestamp() where workspace_id=$1 and id=$2',
      [workspaceId, workflowId, workflow.sourceName],
    );
    await pruneStepSamples(
      client,
      workspaceId,
      workflowId,
      workflow.proposedGraph,
    );
  }
  await client.query(
    `insert into app.workflow_promotion_origins(workspace_id,workflow_id,source_workspace_id,source_workflow_id,source_version_id,source_checksum,graph_digest,target_name,draft_revision,published_version_id,promotion_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(workspace_id,workflow_id) do update set source_version_id=excluded.source_version_id,source_checksum=excluded.source_checksum,graph_digest=excluded.graph_digest,target_name=excluded.target_name,draft_revision=excluded.draft_revision,published_version_id=excluded.published_version_id,promotion_id=excluded.promotion_id,applied_at=clock_timestamp()`,
    [
      workspaceId,
      workflowId,
      input.workspaceId,
      workflow.sourceWorkflowId,
      workflow.sourceVersionId,
      workflow.sourceChecksum,
      promotionDigest(workflow.proposedGraph),
      workflow.sourceName,
      revision,
      workflow.targetPublishedVersionId,
      promotionId,
    ],
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
