import { decodeStoredValue } from '../../shared/stored-values.js';
import { rolesForCapability } from '@pertexo/policy';
import { publicationReviewDecision } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import { appendAuditFact } from '../../governance/audit/facts.js';
import { publishWorkflowCandidate } from '../publication/publish.js';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import type {
  DecideReviewInput,
  ReviewDependencies,
} from './publication-review.types.js';
import { PublicationReviewError } from './publication-review.errors.js';
import {
  projectReview,
  readReviewDraft,
  readReviewRow,
} from './read.repository.js';
import {
  lockReviewedDraftAndRequest,
  recordReviewDecision,
} from './requests.repository.js';

export async function decidePublicationReview(
  client: PoolClient,
  dependencies: ReviewDependencies,
  input: DecideReviewInput,
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
    decodeStoredValue(() =>
      z
        .object({ reviewId: z.literal(input.reviewId) })
        .strict()
        .parse(replay),
    );
    return projectReview(await readReviewRow(client, input));
  }
  const initial = await readReviewRow(client, input);
  await lockReviewedDraftAndRequest(client, {
    workspaceId: input.workspaceId,
    reviewId: input.reviewId,
    workflowId: initial.workflowId,
  });
  const row = await readReviewRow(client, input);
  const decision = publicationReviewDecision({
    requestedBy: row.requestedBy,
    actorId: input.actorId,
    state: row.state,
    decision: input.decision,
  });
  if (!decision.allowed)
    throw new PublicationReviewError(decision.reason, decision.message);
  await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
    actorId: row.requestedBy,
    roles: rolesForCapability('workflow:publish'),
    resource: { workflowId: row.workflowId, capability: 'workflow:publish' },
  });
  // Approval uses the publisher's tag check; rejection has no publication.
  if (input.decision === 'reject')
    await readReviewDraft(client, dependencies, {
      input: { ...input, workflowId: row.workflowId },
      expectedTag: row.representationTag,
    });
  const published =
    input.decision === 'approve'
      ? await publishWorkflowCandidate(
          client,
          {
            ...input,
            workflowId: row.workflowId,
            representationTag: row.representationTag,
          },
          dependencies.catalogs,
        )
      : null;
  await recordReviewDecision(client, input, {
    status: decision.status,
    decidedBy: input.actorId,
    comment: input.comment ?? null,
    publishedVersionId: published?.version.id ?? null,
    reused: published?.reused ?? null,
  });
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    action: decision.action,
    targetType: 'workflow',
    targetId: row.workflowId,
    metadata: {
      publicationRequestId: input.reviewId,
      revision: row.draftRevision,
      ...(published === null ? {} : { versionId: published.version.id }),
    },
  });
  await completeCommand(client, identity, { reviewId: input.reviewId });
  return projectReview(await readReviewRow(client, input));
}
