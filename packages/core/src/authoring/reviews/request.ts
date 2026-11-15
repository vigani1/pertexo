import { decodeStoredValue } from '../../shared/stored-values.js';
import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import { appendAuditFact } from '../../governance/audit/facts.js';
import { requireConnectionBindings } from '../../shared/resources/connection-bindings.repository.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { generatePersistedId } from '@pertexo/database/platform';
import { PublicationReviewError } from './publication-review.errors.js';
import type {
  RequestReviewInput,
  ReviewDependencies,
} from './publication-review.types.js';
import {
  readReviewDraft,
  readReviewSummary,
  readReviewRow,
  projectReview,
} from './read.repository.js';
import {
  countPendingReviews,
  hasPendingRequest,
  insertReviewRequest,
  markSupersededRequestsStale,
  requiresPublishApproval,
} from './requests.repository.js';

/** Pending requests a workspace holds at once. */
const PENDING_REVIEWS_MAX = 100;

export async function requestPublicationReview(
  client: PoolClient,
  dependencies: ReviewDependencies,
  input: RequestReviewInput,
) {
  const identity = {
    workspaceId: input.workspaceId,
    operation: 'workflow.publication.review.request',
    scope: `${input.actorId}:${input.workflowId}`,
    idempotencyKey: input.idempotencyKey,
  };
  const replay = await claimCommand(client, {
    ...identity,
    resourceId: input.workflowId,
    request: { representationTag: input.representationTag, note: input.note },
  });
  if (replay !== null) {
    const { reviewId } = decodeStoredValue(() =>
      z.object({ reviewId: z.uuid() }).strict().parse(replay),
    );
    return readReviewSummary(client, dependencies, { ...input, reviewId });
  }
  if (!(await requiresPublishApproval(client, input.workspaceId)))
    throw new PublicationReviewError(
      'disabled',
      'Publication approval is off. Publish the draft directly.',
    );
  const { draft } = await readReviewDraft(client, dependencies, {
    input,
    expectedTag: input.representationTag,
  });
  await requireConnectionBindings(client, input, draft.graphJson);
  await markSupersededRequestsStale(client, input, input.representationTag);
  if (
    (await countPendingReviews(
      client,
      input.workspaceId,
      PENDING_REVIEWS_MAX,
    )) >= PENDING_REVIEWS_MAX
  )
    throw new PublicationReviewError(
      'limit',
      `This workspace has ${String(PENDING_REVIEWS_MAX)} pending publication requests. Decide an existing request first.`,
    );
  if (await hasPendingRequest(client, input))
    throw new PublicationReviewError(
      'decided',
      'This draft already has a pending publication request. Open its review.',
    );
  const reviewId = generatePersistedId();
  await insertReviewRequest(client, {
    workspaceId: input.workspaceId,
    reviewId,
    workflowId: input.workflowId,
    requestedBy: input.actorId,
    draftRevision: draft.revision,
    representationTag: input.representationTag,
    note: input.note,
  });
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    action: 'workflow.publication_requested',
    targetType: 'workflow',
    targetId: input.workflowId,
    metadata: { publicationRequestId: reviewId, revision: draft.revision },
  });
  await completeCommand(client, identity, { reviewId });
  return projectReview(await readReviewRow(client, { ...input, reviewId }));
}
