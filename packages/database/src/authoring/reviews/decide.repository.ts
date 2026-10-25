import {
  publicationReviewDecision,
  rolesForCapability,
} from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { appendAuditFact } from '../../governance/audit/events.repository.js';
import {
  claimCommand,
  completeCommand,
} from '../../platform/idempotency/repository.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { workflowPublicationRequests } from '../../schema/authoring/publication-requests.js';
import { workflowDrafts } from '../../schema/authoring/workflows.js';
import { publishWorkflowCandidate } from '../publication/publisher.repository.js';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import type { PublicationReviewStore, ReviewDependencies } from './contract.js';
import { PublicationReviewError } from './errors.js';
import {
  projectReview,
  readReviewDraft,
  readReviewRow,
} from './read.queries.js';

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
  const db = drizzle(client);
  await db
    .select({ workflowId: workflowDrafts.workflowId })
    .from(workflowDrafts)
    .where(
      and(
        eq(workflowDrafts.workspaceId, input.workspaceId),
        eq(workflowDrafts.workflowId, initial.workflowId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  await db
    .select({ id: workflowPublicationRequests.id })
    .from(workflowPublicationRequests)
    .where(
      and(
        eq(workflowPublicationRequests.workspaceId, input.workspaceId),
        eq(workflowPublicationRequests.id, input.reviewId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
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
      ? await publishWorkflowCandidate(dependencies, client, {
          ...input,
          workflowId: row.workflowId,
          representationTag: row.representationTag,
        })
      : null;
  await db
    .update(workflowPublicationRequests)
    .set({
      status: decision.status,
      decidedBy: input.actorId,
      decidedAt: sql`clock_timestamp()`,
      comment: input.comment ?? null,
      publishedVersionId: published?.version.id ?? null,
      reused: published?.reused ?? null,
    })
    .where(
      and(
        eq(workflowPublicationRequests.workspaceId, input.workspaceId),
        eq(workflowPublicationRequests.id, input.reviewId),
      ),
    )
    .catch(rethrowQueryFailure);
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
