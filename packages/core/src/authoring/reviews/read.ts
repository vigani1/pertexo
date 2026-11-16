import type { ReviewRow } from './read.repository.js';
import {
  lockReviewDraftRow,
  projectReview,
  readLiveVersion,
  findReviewRow,
} from './read.repository.js';
import type { PoolClient } from 'pg';
import {
  projectDraft,
  projectVersion,
} from '../workflows/representation/workflow-representations.repository.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '../workflows/workflow-authoring.errors.js';
import { draftRepresentationTag } from '../workflows/representation/tag.js';
import type {
  ReviewDependencies,
  ReviewScope,
} from './publication-review.types.js';

export async function readReviewRow(
  client: PoolClient,
  input: ReviewScope & { reviewId: string },
): Promise<ReviewRow> {
  const found = await findReviewRow(client, input);
  if (found === undefined)
    throw new WorkflowNotFoundError('Publication request is not visible');
  return found;
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
  const row = await lockReviewDraftRow(client, input, lock);
  if (row === undefined)
    throw new WorkflowNotFoundError('Workflow draft is not visible');
  const draft = projectDraft(row, dependencies.catalogs.definitionCatalog);
  const tag = draftRepresentationTag(input.workflowId, draft);
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
  const live = await readLiveVersion(client, input.workspaceId, row.workflowId);
  return {
    request: projectReview(row),
    graph,
    liveGraph: live === undefined ? null : projectVersion(live).graphJson,
  };
}
