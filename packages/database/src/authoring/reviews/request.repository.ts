import { bindResourcePredicate } from '../../tenant-access/resources/scope.queries.js';
import { requireConnectionBindings } from '../../tenant-access/resources/connections/bindings.queries.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  claimCommand,
  completeCommand,
} from '../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { appendAuditFact } from '../../governance/audit/events.repository.js';
import {
  PublicationReviewError,
  type PublicationReviewStore,
  type ReviewDependencies,
} from './contract.js';
import {
  readReviewDraft,
  readReviewSummary,
  readReviewRow,
  projectReview,
} from './read.queries.js';
import { REVIEW_SOURCE_SQL, reviewStateSql } from './eligibility.queries.js';

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
  const workspace = (
    await client.query<{ require_publish_approval: boolean }>(
      'select require_publish_approval from app.workspaces where id=$1',
      [input.workspaceId],
    )
  ).rows[0];
  if (!(workspace?.require_publish_approval ?? false))
    throw new PublicationReviewError(
      'disabled',
      'Publication approval is off. Publish the draft directly.',
    );
  const { draft } = await readReviewDraft(client, dependencies, {
    input,
    expectedTag: input.representationTag,
  });
  await requireConnectionBindings(client, input, draft.graphJson);
  const staleParameters: unknown[] = [
    input.workspaceId,
    input.workflowId,
    input.representationTag,
  ];
  const staleState = bindResourcePredicate(reviewStateSql, staleParameters);
  await client.query(
    `update app.workflow_publication_requests current set status='stale' where current.workspace_id=$1 and current.workflow_id=$2 and current.status='pending'
     and (current.representation_tag<>$3 or current.id in (select review.id ${REVIEW_SOURCE_SQL} where review.workspace_id=$1 and review.workflow_id=$2 and (${staleState})<>'pending'))`,
    staleParameters,
  );
  const pendingParameters: unknown[] = [input.workspaceId];
  const pendingState = bindResourcePredicate(reviewStateSql, pendingParameters);
  const pending = await client.query(
    `select review.id ${REVIEW_SOURCE_SQL} where review.workspace_id=$1 and (${pendingState})='pending' limit 100`,
    pendingParameters,
  );
  if (pending.rows.length >= 100)
    throw new PublicationReviewError(
      'limit',
      'This workspace has 100 pending publication requests. Decide an existing request first.',
    );
  const existing = await client.query(
    "select id from app.workflow_publication_requests where workspace_id=$1 and workflow_id=$2 and status='pending'",
    [input.workspaceId, input.workflowId],
  );
  if (existing.rowCount !== 0)
    throw new PublicationReviewError(
      'decided',
      'This draft already has a pending publication request. Open its review.',
    );
  const reviewId = generatePersistedId();
  await client.query(
    `insert into app.workflow_publication_requests(workspace_id,id,workflow_id,requested_by,draft_revision,representation_tag,note,expires_at)
    values($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '7 days')`,
    [
      input.workspaceId,
      reviewId,
      input.workflowId,
      input.actorId,
      draft.revision,
      input.representationTag,
      input.note,
    ],
  );
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
