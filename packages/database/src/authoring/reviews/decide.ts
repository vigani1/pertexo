import type { PoolClient } from 'pg';
import { z } from 'zod';
import { claimCommand, completeCommand } from '../../platform/idempotency/repository.js';
import { appendAuditFact } from '../../governance/audit/events.repository.js';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import { publishWorkflowCandidate } from '../publication/publisher.js';
import {
  PublicationReviewError,
  type PublicationReviewStore,
  type ReviewDependencies,
} from './contract.js';
import { readReviewDraft, readReviewRow, projectReview } from './read.js';

export async function decidePublicationReview(
  client: PoolClient,
  dependencies: ReviewDependencies,
  input: Parameters<PublicationReviewStore['decide']>[0],
) {
  const identity = {
    workspaceId: input.workspaceId,
    operation: 'workflow.publication.review.decide',
    scope: `${input.actorId}:${input.reviewId}`,
    idempotencyKey: input.idempotencyKey,
  };
  const replay = await claimCommand(client, {
    ...identity,
    resourceId: input.reviewId,
    request: { decision: input.decision, comment: input.comment ?? null },
  });
  if (replay !== null) {
    z.object({ reviewId: z.literal(input.reviewId) })
      .strict()
      .parse(replay);
    return projectReview(await readReviewRow(client, input));
  }
  const initial = await readReviewRow(client, input);
  await client.query(
    'select workflow_id from app.workflow_drafts where workspace_id=$1 and workflow_id=$2 for update',
    [input.workspaceId, initial.workflow_id],
  );
  await client.query(
    'select id from app.workflow_publication_requests where workspace_id=$1 and id=$2 for update',
    [input.workspaceId, input.reviewId],
  );
  const row = await readReviewRow(client, input);
  if (row.requested_by === input.actorId)
    throw new PublicationReviewError(
      'self',
      'Another owner or admin must decide your publication request.',
    );
  if (row.state !== 'pending')
    throw new PublicationReviewError(
      row.state === 'approved' || row.state === 'rejected'
        ? 'decided'
        : 'stale',
      'This publication request is no longer pending. Review the latest draft and request approval again.',
    );
  await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
    actorId: row.requested_by,
    roles: rolesForCapability('workflow:publish'),
    resource: { workflowId: row.workflow_id, capability: 'workflow:publish' },
  });
  // Approval uses the publisher's tag check; rejection has no publication.
  if (input.decision === 'reject')
    await readReviewDraft(client, dependencies, {
      input: { ...input, workflowId: row.workflow_id },
      expectedTag: row.representation_tag,
    });
  const published =
    input.decision === 'approve'
      ? await publishWorkflowCandidate(dependencies, client, {
          ...input,
          workflowId: row.workflow_id,
          representationTag: row.representation_tag,
        })
      : null;
  await client.query(
    `update app.workflow_publication_requests set status=$3,decided_by=$4,decided_at=clock_timestamp(),comment=$5,published_version_id=$6,reused=$7
    where workspace_id=$1 and id=$2`,
    [
      input.workspaceId,
      input.reviewId,
      input.decision === 'approve' ? 'approved' : 'rejected',
      input.actorId,
      input.comment ?? null,
      published?.version.id ?? null,
      published?.reused ?? null,
    ],
  );
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    action:
      input.decision === 'approve'
        ? 'workflow.publication_approved'
        : 'workflow.publication_rejected',
    targetType: 'workflow',
    targetId: row.workflow_id,
    metadata: {
      publicationRequestId: input.reviewId,
      revision: row.draft_revision,
      ...(published === null ? {} : { versionId: published.version.id }),
    },
  });
  await completeCommand(client, identity, { reviewId: input.reviewId });
  return projectReview(await readReviewRow(client, input));
}
