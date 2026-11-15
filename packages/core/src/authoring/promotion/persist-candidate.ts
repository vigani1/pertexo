import type { PoolClient } from 'pg';
import type { WorkflowPromotionPreview } from '@pertexo/contracts';
import {
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';
import { publishWorkflowDirectly } from '../publication/publish.js';
import { requestPublicationReview } from '../reviews/request.js';
import type {
  ApplyPromotionInput,
  PromotionContext,
} from './workflow-promotion.types.js';
import { persistPromotionCandidate } from './candidate.repository.js';

export async function writePromotedDraft(
  client: PoolClient,
  context: PromotionContext,
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
    const published = await publishWorkflowDirectly(
      client,
      command,
      context.catalogs,
    );
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
