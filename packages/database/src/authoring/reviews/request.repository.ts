import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowPublicationRequests } from '../../schema/authoring/publication-requests.js';
import { workspaces } from '../../schema/foundation.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { requireConnectionBindings } from '../../tenant-access/resources/connections/bindings.queries.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  claimCommand,
  completeCommand,
} from '../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { appendAuditFact } from '../../governance/audit/events.repository.js';
import { PublicationReviewError } from './errors.js';
import type { PublicationReviewStore, ReviewDependencies } from './contract.js';
import {
  readReviewDraft,
  readReviewSummary,
  readReviewRow,
  projectReview,
} from './read.queries.js';
import { reviewSource, review, reviewStateSql } from './eligibility.queries.js';

export async function requestPublicationReview(
  client: PoolClient,
  dependencies: ReviewDependencies,
  input: Parameters<PublicationReviewStore['request']>[0],
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
    const { reviewId } = z
      .object({ reviewId: z.uuid() })
      .strict()
      .parse(replay);
    return readReviewSummary(client, dependencies, { ...input, reviewId });
  }
  const db = drizzle(client);
  const [workspace] = await db
    .select({ requirePublishApproval: workspaces.requirePublishApproval })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .catch(rethrowQueryFailure);
  if (!(workspace?.requirePublishApproval ?? false))
    throw new PublicationReviewError(
      'disabled',
      'Publication approval is off. Publish the draft directly.',
    );
  const { draft } = await readReviewDraft(client, dependencies, {
    input,
    expectedTag: input.representationTag,
  });
  await requireConnectionBindings(client, input, draft.graphJson);
  const stale = reviewSource(db, { id: review.id }).where(
    and(
      eq(review.workspaceId, input.workspaceId),
      eq(review.workflowId, input.workflowId),
      ne(reviewStateSql, 'pending'),
    ),
  );
  await db
    .update(workflowPublicationRequests)
    .set({ status: 'stale' })
    .where(
      and(
        eq(workflowPublicationRequests.workspaceId, input.workspaceId),
        eq(workflowPublicationRequests.workflowId, input.workflowId),
        eq(workflowPublicationRequests.status, 'pending'),
        or(
          ne(
            workflowPublicationRequests.representationTag,
            input.representationTag,
          ),
          inArray(workflowPublicationRequests.id, stale),
        ),
      ),
    )
    .catch(rethrowQueryFailure);
  const pending = await reviewSource(db, { id: review.id })
    .where(
      and(
        eq(review.workspaceId, input.workspaceId),
        eq(reviewStateSql, 'pending'),
      ),
    )
    .limit(100)
    .catch(rethrowQueryFailure);
  if (pending.length >= 100)
    throw new PublicationReviewError(
      'limit',
      'This workspace has 100 pending publication requests. Decide an existing request first.',
    );
  const existing = await db
    .select({ id: workflowPublicationRequests.id })
    .from(workflowPublicationRequests)
    .where(
      and(
        eq(workflowPublicationRequests.workspaceId, input.workspaceId),
        eq(workflowPublicationRequests.workflowId, input.workflowId),
        eq(workflowPublicationRequests.status, 'pending'),
      ),
    )
    .catch(rethrowQueryFailure);
  if (existing.length !== 0)
    throw new PublicationReviewError(
      'decided',
      'This draft already has a pending publication request. Open its review.',
    );
  const reviewId = generatePersistedId();
  await db
    .insert(workflowPublicationRequests)
    .values({
      workspaceId: input.workspaceId,
      id: reviewId,
      workflowId: input.workflowId,
      requestedBy: input.actorId,
      draftRevision: draft.revision,
      representationTag: input.representationTag,
      note: input.note,
      expiresAt: sql`clock_timestamp()+interval '7 days'`,
    })
    .catch(rethrowQueryFailure);
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
