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
} from '../../tenant-access/resources/connections/bindings.queries.js';
import { connectionScope } from '../../tenant-access/resources/connections/scope.js';
import { readBrowsableFolderScope } from '../../shared/facts.queries.js';
import { workflowAccessible } from '../../tenant-access/resources/workflows.queries.js';
import type { PoolClient } from 'pg';
import type { PublicationReview } from '@pertexo/contracts';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/server';
import {
  projectDraft,
  projectVersion,
  draftProjection,
  versionProjection,
} from '../workflows/representation/records.queries.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '../workflows/errors.js';
import type { ReviewDependencies, ReviewScope } from './contract.js';
import { review, reviewDetails } from './eligibility.queries.js';
type ReviewRow = Awaited<ReturnType<typeof reviewDetails>>[number]['record'];
export async function readReviewRow(
  client: PoolClient,
  input: ReviewScope & { reviewId: string },
): Promise<ReviewRow> {
  const [selected] = await reviewDetails(drizzle(client), input.actorId)
    .where(
      and(
        eq(review.workspaceId, input.workspaceId),
        eq(review.id, input.reviewId),
      ),
    )
    .catch(rethrowQueryFailure);
  const row = selected?.record;
  if (row === undefined)
    throw new WorkflowNotFoundError('Publication request is not visible');
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
          workflowConnectionReferences(parseWorkflowGraphDraft(row.draftGraph)),
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
export async function readReviewDraft(
  client: PoolClient,
  dependencies: ReviewDependencies,
  {
    input,
    expectedTag,
    lock = 'update',
  }: Readonly<{
    input: ReviewScope & { workflowId: string };
    expectedTag?: string | undefined;
    lock?: ('share' | 'update') | undefined;
  }>,
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
  if (row === undefined)
    throw new WorkflowNotFoundError('Workflow draft is not visible');
  const draft = projectDraft(row, dependencies.catalogs.definitionCatalog);
  const tag = workflowDraftRepresentationTag({
    workflowId: input.workflowId,
    revision: draft.revision,
    graph: draft.graphJson,
    compatibilityFingerprint: draft.compatibility.fingerprint,
  });
  if (expectedTag !== undefined && tag !== expectedTag)
    throw new WorkflowRevisionConflictError(draft.revision, tag);
  return { draft, tag };
}
async function readReviewedCandidate(
  client: PoolClient,
  dependencies: ReviewDependencies,
  input: ReviewScope & { reviewId: string },
) {
  const row = await readReviewRow(client, input);
  let graph = null;
  if (row.state === 'pending') {
    const candidate = await readReviewDraft(client, dependencies, {
      input: { ...input, workflowId: row.workflowId },
      expectedTag: undefined,
      lock: 'share',
    });
    if (candidate.tag === row.representationTag)
      graph = candidate.draft.graphJson;
    else {
      row.state = 'stale';
      row.canDecide = false;
    }
  }
  return { row, graph };
}
export async function readReviewSummary(
  client: PoolClient,
  dependencies: ReviewDependencies,
  input: ReviewScope & { reviewId: string },
) {
  return projectReview(
    (await readReviewedCandidate(client, dependencies, input)).row,
  );
}
export async function readReviewDetail(
  client: PoolClient,
  dependencies: ReviewDependencies,
  input: ReviewScope & { reviewId: string },
) {
  const { row, graph } = await readReviewedCandidate(
    client,
    dependencies,
    input,
  );
  if (graph === null)
    return { request: projectReview(row), graph: null, liveGraph: null };
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
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, row.workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  return {
    request: projectReview(row),
    graph,
    liveGraph: live === undefined ? null : projectVersion(live).graphJson,
  };
}
