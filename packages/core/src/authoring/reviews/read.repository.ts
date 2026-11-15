import { decodeStoredValue } from '../../shared/stored-values.js';
import { and, eq } from 'drizzle-orm';
import {
  workflowDrafts,
  workflowVersions,
  workflows,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { drizzle } from 'drizzle-orm/node-postgres';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import {
  connectionUseIssues,
  workflowConnectionReferences,
} from '../../shared/resources/connection-bindings.repository.js';
import { connectionScope } from '../../shared/resources/connection-scope.repository.js';
import { readBrowsableFolderScope } from '../../shared/folder-access-facts.repository.js';
import { workflowAccessible } from '../../shared/resources/workflow-access.repository.js';
import type { PoolClient } from 'pg';
import type { PublicationReview } from '@pertexo/contracts';
import {
  draftProjection,
  versionProjection,
} from '../workflows/representation/workflow-representations.repository.js';
import type { ReviewScope } from './publication-review.types.js';
import { review, reviewDetails } from './eligibility.repository.js';

export type ReviewRow = Awaited<
  ReturnType<typeof reviewDetails>
>[number]['record'];
export async function findReviewRow(
  client: PoolClient,
  input: ReviewScope & { reviewId: string },
): Promise<ReviewRow | undefined> {
  const [selected] = await reviewDetails(drizzle(client), input.actorId)
    .where(
      and(
        eq(review.workspaceId, input.workspaceId),
        eq(review.id, input.reviewId),
      ),
    )
    .catch(rethrowQueryFailure);
  const row = selected?.record;
  if (row === undefined) return undefined;
  if (row.state === 'pending') {
    const requester = {
      workspaceId: input.workspaceId,
      actorId: row.requestedBy,
    };
    const resources = await readBrowsableFolderScope(client, requester);
    const canPublish = await workflowAccessible(client, resources, {
      workspaceId: input.workspaceId,
      workflowId: row.workflowId,
      capability: 'workflow:publish',
    });
    const issues = canPublish
      ? await connectionUseIssues(
          { db: drizzle(client) },
          connectionScope(requester, resources.role, 'connection:use'),
          workflowConnectionReferences(
            decodeStoredValue(() => parseWorkflowGraphDraft(row.draftGraph)),
          ),
        )
      : [];
    if (!canPublish || issues.length > 0) {
      row.state = 'stale';
      row.canDecide = false;
    }
  }
  return row;
}
export function projectReview(row: ReviewRow): PublicationReview {
  return {
    id: row.id,
    workflowId: row.workflowId,
    workflowName: row.workflowName,
    requestedBy: row.requestedBy,
    requesterName: row.requesterName,
    draftRevision: row.draftRevision,
    note: row.note,
    status: row.state,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedBy: row.decidedBy,
    deciderName: row.deciderName,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    comment: row.comment,
    publishedVersionId: row.publishedVersionId,
    versionNumber: row.versionNumber,
    canDecide: row.canDecide,
  };
}

export async function lockReviewDraftRow(
  client: PoolClient,
  input: ReviewScope & { workflowId: string },
  lock: 'share' | 'update',
) {
  const [row] = await drizzle(client)
    .select(draftProjection)
    .from(workflowDrafts)
    .where(
      and(
        eq(workflowDrafts.workspaceId, input.workspaceId),
        eq(workflowDrafts.workflowId, input.workflowId),
      ),
    )
    .for(lock)
    .catch(rethrowQueryFailure);
  return row;
}

/** The workflow's published version, if it has one. */
export async function readLiveVersion(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
) {
  const [live] = await drizzle(client)
    .select(versionProjection)
    .from(workflowVersions)
    .innerJoin(
      workflows,
      and(
        eq(workflows.workspaceId, workflowVersions.workspaceId),
        eq(workflows.publishedVersionId, workflowVersions.id),
      ),
    )
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .catch(rethrowQueryFailure);
  return live;
}
