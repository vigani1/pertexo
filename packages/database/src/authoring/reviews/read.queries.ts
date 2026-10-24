import { sql } from 'drizzle-orm';
import { bindResourcePredicate } from '../../tenant-access/resources/scope.queries.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import {
  connectionUseIssues,
  workflowConnectionReferences,
} from '../../tenant-access/resources/connections/bindings.queries.js';
import { connectionScope } from '../../tenant-access/resources/connections/scope.js';
import { readFolderScope } from '../../tenant-access/resources/facts.queries.js';
import { workflowAccessible } from '../../tenant-access/resources/workflows.queries.js';
import type { PoolClient } from 'pg';
import type { PublicationReview } from '@pertexo/contracts';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/server';
import {
  mapDraft,
  mapVersion,
  workflowVersionRowSelection,
} from '../workflows/representation/records.queries.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '../workflows/errors.js';
import type { ReviewDependencies, ReviewScope } from './contract.js';
import {
  REVIEW_SOURCE_SQL,
  reviewStateSql,
  reviewDecisionAllowedSql,
} from './eligibility.queries.js';

interface ReviewRow {
  draft_graph: unknown;
  id: string;
  workflow_id: string;
  workflow_name: string;
  requested_by: string;
  requester_name: string;
  draft_revision: number;
  representation_tag: string;
  note: string;
  state: PublicationReview['status'];
  created_at: Date;
  expires_at: Date;
  decided_by: string | null;
  decider_name: string | null;
  decided_at: Date | null;
  comment: string | null;
  published_version_id: string | null;
  version_number: number | null;
  can_decide: boolean;
}
export async function readReviewRow(
  client: PoolClient,
  input: ReviewScope & { reviewId: string },
): Promise<ReviewRow> {
  const parameters: unknown[] = [
    input.workspaceId,
    input.reviewId,
    input.actorId,
  ];
  const state = bindResourcePredicate(reviewStateSql, parameters);
  const allowed = bindResourcePredicate(
    reviewDecisionAllowedSql(sql`$3`, sql`actor.role`),
    parameters,
  );
  const row = (
    await client.query<ReviewRow>(
      `select review.*,draft.graph_json draft_graph,workflow.name workflow_name,requester_user.display_name requester_name,
    decider.display_name decider_name,version.version_number,(${state}) state,
    ${allowed} can_decide
    ${REVIEW_SOURCE_SQL}
    left join app.users decider on decider.id=review.decided_by
    left join app.workflow_versions version on version.workspace_id=review.workspace_id and version.id=review.published_version_id
    join app.workspace_memberships actor on actor.workspace_id=review.workspace_id and actor.user_id=$3 and actor.status='active'
    where review.workspace_id=$1 and review.id=$2`,
      parameters,
    )
  ).rows[0];
  if (row === undefined)
    throw new WorkflowNotFoundError('Publication request is not visible');
  if (row.state === 'pending') {
    const requester = {
      workspaceId: input.workspaceId,
      actorId: row.requested_by,
    };
    const resources = await readFolderScope(client, requester);
    const canPublish = await workflowAccessible(client, resources, {
      workspaceId: input.workspaceId,
      workflowId: row.workflow_id,
      capability: 'workflow:publish',
    });
    const issues = canPublish
      ? await connectionUseIssues(
          { db: drizzle(client) },
          connectionScope(requester, resources.role, 'connection:use'),
          workflowConnectionReferences(
            parseWorkflowGraphDraft(row.draft_graph),
          ),
        )
      : [];
    if (!canPublish || issues.length > 0) {
      row.state = 'stale';
      row.can_decide = false;
    }
  }
  return row;
}
export function projectReview(row: ReviewRow): PublicationReview {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    requestedBy: row.requested_by,
    requesterName: row.requester_name,
    draftRevision: row.draft_revision,
    note: row.note,
    status: row.state,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    decidedBy: row.decided_by,
    deciderName: row.decider_name,
    decidedAt: row.decided_at?.toISOString() ?? null,
    comment: row.comment,
    publishedVersionId: row.published_version_id,
    versionNumber: row.version_number,
    canDecide: row.can_decide,
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
  const row = (
    await client.query<Record<string, unknown>>(
      `select * from app.workflow_drafts where workspace_id=$1 and workflow_id=$2 for ${lock}`,
      [input.workspaceId, input.workflowId],
    )
  ).rows[0];
  if (row === undefined)
    throw new WorkflowNotFoundError('Workflow draft is not visible');
  const draft = mapDraft(row, dependencies.catalogs.definitionCatalog);
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
      input: { ...input, workflowId: row.workflow_id },
      expectedTag: undefined,
      lock: 'share',
    });
    if (candidate.tag === row.representation_tag)
      graph = candidate.draft.graphJson;
    else {
      row.state = 'stale';
      row.can_decide = false;
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
  const live = (
    await client.query<Record<string, unknown>>(
      `select ${workflowVersionRowSelection
        .split(',')
        .map((column) => `version.${column}`)
        .join(',')} from app.workflow_versions version
     join app.workflows workflow on workflow.workspace_id=version.workspace_id and workflow.published_version_id=version.id
     where workflow.workspace_id=$1 and workflow.id=$2`,
      [input.workspaceId, row.workflow_id],
    )
  ).rows[0];
  return {
    request: projectReview(row),
    graph,
    liveGraph: live === undefined ? null : mapVersion(live).graphJson,
  };
}
