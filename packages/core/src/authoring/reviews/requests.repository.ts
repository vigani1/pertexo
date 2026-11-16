import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowDrafts,
  workflowPublicationRequests,
  workspaces,
} from '@pertexo/database/schema';
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { DAY_INTERVAL } from '../../shared/sql-intervals.repository.js';
import type { WorkflowRef } from '../../shared/access/workflow-actor.types.js';
import {
  review,
  reviewSource,
  reviewStateSql,
} from './eligibility.repository.js';

/** How long a request waits for a decision. */
const REVIEW_LIFETIME_DAYS = 7;

type ReviewRef = Readonly<{ workspaceId: string; reviewId: string }>;

/** Whether the workspace sends drafts through publication review. */
export async function requiresPublishApproval(
  client: PoolClient,
  workspaceId: string,
): Promise<boolean> {
  const [workspace] = await drizzle(client)
    .select({ requirePublishApproval: workspaces.requirePublishApproval })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .catch(rethrowQueryFailure);
  return workspace?.requirePublishApproval ?? false;
}

/**
 * A decision locks the workflow's draft and then the request, the order
 * publication takes the draft in.
 */
export async function lockReviewedDraftAndRequest(
  client: PoolClient,
  {
    workspaceId,
    reviewId,
    workflowId,
  }: ReviewRef & Readonly<{ workflowId: string }>,
): Promise<void> {
  const db = drizzle(client);
  await db
    .select({ workflowId: workflowDrafts.workflowId })
    .from(workflowDrafts)
    .where(
      and(
        eq(workflowDrafts.workspaceId, workspaceId),
        eq(workflowDrafts.workflowId, workflowId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  await db
    .select({ id: workflowPublicationRequests.id })
    .from(workflowPublicationRequests)
    .where(
      and(
        eq(workflowPublicationRequests.workspaceId, workspaceId),
        eq(workflowPublicationRequests.id, reviewId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
}

export async function recordReviewDecision(
  client: PoolClient,
  { workspaceId, reviewId }: ReviewRef,
  decision: Readonly<{
    status: 'approved' | 'rejected';
    decidedBy: string;
    comment: string | null;
    publishedVersionId: string | null;
    reused: boolean | null;
  }>,
): Promise<void> {
  await drizzle(client)
    .update(workflowPublicationRequests)
    .set({
      status: decision.status,
      decidedBy: decision.decidedBy,
      decidedAt: sql`clock_timestamp()`,
      comment: decision.comment,
      publishedVersionId: decision.publishedVersionId,
      reused: decision.reused,
    })
    .where(
      and(
        eq(workflowPublicationRequests.workspaceId, workspaceId),
        eq(workflowPublicationRequests.id, reviewId),
      ),
    )
    .catch(rethrowQueryFailure);
}

/**
 * A pending request for this workflow goes stale when its draft tag differs
 * from the new request's, or when its review no longer reads as pending.
 */
export async function markSupersededRequestsStale(
  client: PoolClient,
  { workspaceId, workflowId }: WorkflowRef,
  representationTag: string,
): Promise<void> {
  const db = drizzle(client);
  const stale = reviewSource(db, { id: review.id }).where(
    and(
      eq(review.workspaceId, workspaceId),
      eq(review.workflowId, workflowId),
      ne(reviewStateSql, 'pending'),
    ),
  );
  await db
    .update(workflowPublicationRequests)
    .set({ status: 'stale' })
    .where(
      and(
        eq(workflowPublicationRequests.workspaceId, workspaceId),
        eq(workflowPublicationRequests.workflowId, workflowId),
        eq(workflowPublicationRequests.status, 'pending'),
        or(
          ne(workflowPublicationRequests.representationTag, representationTag),
          inArray(workflowPublicationRequests.id, stale),
        ),
      ),
    )
    .catch(rethrowQueryFailure);
}

/** The workspace's pending reviews, counted up to `limit`. */
export async function countPendingReviews(
  client: PoolClient,
  workspaceId: string,
  limit: number,
): Promise<number> {
  const pending = await reviewSource(drizzle(client), { id: review.id })
    .where(
      and(eq(review.workspaceId, workspaceId), eq(reviewStateSql, 'pending')),
    )
    .limit(limit)
    .catch(rethrowQueryFailure);
  return pending.length;
}

/** Whether the workflow still has a request stored as pending. */
export async function hasPendingRequest(
  client: PoolClient,
  { workspaceId, workflowId }: WorkflowRef,
): Promise<boolean> {
  const existing = await drizzle(client)
    .select({ id: workflowPublicationRequests.id })
    .from(workflowPublicationRequests)
    .where(
      and(
        eq(workflowPublicationRequests.workspaceId, workspaceId),
        eq(workflowPublicationRequests.workflowId, workflowId),
        eq(workflowPublicationRequests.status, 'pending'),
      ),
    )
    .catch(rethrowQueryFailure);
  return existing.length !== 0;
}

export async function insertReviewRequest(
  client: PoolClient,
  request: ReviewRef &
    Readonly<{
      workflowId: string;
      requestedBy: string;
      draftRevision: number;
      representationTag: string;
      note: string;
    }>,
): Promise<void> {
  await drizzle(client)
    .insert(workflowPublicationRequests)
    .values({
      workspaceId: request.workspaceId,
      id: request.reviewId,
      workflowId: request.workflowId,
      requestedBy: request.requestedBy,
      draftRevision: request.draftRevision,
      representationTag: request.representationTag,
      note: request.note,
      expiresAt: sql`clock_timestamp()+${REVIEW_LIFETIME_DAYS}*${DAY_INTERVAL}`,
    })
    .catch(rethrowQueryFailure);
}
