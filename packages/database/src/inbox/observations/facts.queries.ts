import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { readCommentMentionSource } from './mentions.queries.js';
import { review, reviewRecords } from '../../authoring/reviews/eligibility.queries.js';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflows } from '../../schema/authoring/workflows.js';
import { connections } from '../../schema/connections.js';
import { task, run } from '../../runs/pending-tasks/responses/eligibility.js';
import { workspaces } from '../../schema/foundation.js';
import {
  workspaceExecutionEntitlements as pointer,
  workspaceExecutionEntitlementVersions as entitlement,
} from '../../schema/runs/capacity/entitlements.js';
import { workspaceArtifactCapacity as capacity } from '../../schema/transport.js';
import { slotCounts } from './capacity.queries.js';
import type { PoolClient } from 'pg';
import { readCapacityWarning } from './capacity.queries.js';
import type {
  WorkspaceCapacityLimit,
  WorkspaceNoticeKind,
} from '@pertexo/contracts';
export type AttentionSubject = Readonly<{
  workspaceId: string;
  subjectId: string;
}> &
  (
    | Readonly<{
        noticeKind: 'limit_approaching';
        capacityLimit: WorkspaceCapacityLimit;
      }>
    | Readonly<{
        noticeKind: Exclude<
          WorkspaceNoticeKind,
          'workflow_failure' | 'limit_approaching'
        >;
      }>
  );
export type AttentionFact = Readonly<{
  active: boolean;
  sourceRevision: string;
  workflowId: string | null;
  connectionId: string | null;
  taskId: string | null;
  publicationRequestId: string | null;
  commentMentionId: string | null;
  occurredAt: Date | null;
}>;
/** Current source facts, read under the observation's workspace/source fence. */
export async function readAttentionFact(
  client: PoolClient,
  subject: AttentionSubject,
): Promise<AttentionFact> {
  switch (subject.noticeKind) {
    case 'workflow_mention':
      return readMentionFact(client, subject);
    case 'workflow_auto_paused':
      return readAutoPauseFact(client, subject);
    case 'connection_attention':
      return readConnectionAttentionFact(client, subject);
    case 'publication_review_waiting':
      return readPublicationReviewFact(client, subject);
    case 'approval_waiting':
      return readApprovalFact(client, subject);
    case 'limit_approaching':
      return {
        ...base,
        active: await readCapacityWarning(
          client,
          subject.workspaceId,
          subject.capacityLimit,
        ),
        sourceRevision: subject.capacityLimit,
      };
    case 'limit_reached':
      return readLimitReachedFact(client, subject);
  }
}

const base = {
  active: false,
  sourceRevision: 'resolved',
  workflowId: null,
  connectionId: null,
  taskId: null,
  publicationRequestId: null,
  commentMentionId: null,
  occurredAt: null,
};
async function readMentionFact(
  client: PoolClient,
  subject: AttentionSubject,
): Promise<AttentionFact> {
  const source = await readCommentMentionSource(client, subject);
  return {
    ...base,
    workflowId: source?.workflowId ?? null,
    commentMentionId: subject.subjectId,
    active: source?.active ?? false,
    sourceRevision: subject.subjectId,
    occurredAt: source?.occurredAt ?? null,
  };
}
async function readAutoPauseFact(
  client: PoolClient,
  subject: AttentionSubject,
): Promise<AttentionFact> {
  const [row] = await drizzle(client)
    .select({
      trigger_pause_state: workflows.triggerPauseState,
      trigger_pause_revision: sql<string>`${workflows.triggerPauseRevision}::text`,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, subject.workspaceId),
        eq(workflows.id, subject.subjectId),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  return {
    ...base,
    workflowId: subject.subjectId,
    active: row?.trigger_pause_state === 'paused',
    sourceRevision: row?.trigger_pause_revision ?? 'removed',
  };
}
async function readConnectionAttentionFact(
  client: PoolClient,
  subject: AttentionSubject,
): Promise<AttentionFact> {
  const [row] = await drizzle(client)
    .select({
      status: connections.status,
      health_revision: sql<string>`${connections.healthRevision}::text`,
    })
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, subject.workspaceId),
        eq(connections.id, subject.subjectId),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  return {
    ...base,
    connectionId: subject.subjectId,
    active: row?.status === 'reauthorization_required',
    sourceRevision: row?.health_revision ?? 'removed',
  };
}
async function readPublicationReviewFact(
  client: PoolClient,
  subject: AttentionSubject,
): Promise<AttentionFact> {
  const [row] = await reviewRecords(drizzle(client))
    .where(
      and(
        eq(review.workspaceId, subject.workspaceId),
        eq(review.id, subject.subjectId),
      ),
    )
    .catch(rethrowQueryFailure);
  return {
    ...base,
    workflowId: row?.workflowId ?? null,
    publicationRequestId: subject.subjectId,
    active: row?.active ?? false,
    sourceRevision: subject.subjectId,
  };
}
async function readApprovalFact(
  client: PoolClient,
  subject: AttentionSubject,
): Promise<AttentionFact> {
  const db = drizzle(client);
  const predicate = and(
    eq(task.workspaceId, subject.workspaceId),
    eq(task.id, subject.subjectId),
  );
  // Decisions and the coordinator lock the run before its task.
  await db
    .select({ id: run.id })
    .from(run)
    .where(
      and(
        eq(run.workspaceId, subject.workspaceId),
        eq(
          run.id,
          db.select({ runId: task.runId }).from(task).where(predicate),
        ),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  const [row] = await db
    .select({
      workflow_id: run.workflowId,
      pending: sql<boolean>`(${task.kind}='approval' and ${task.status}='pending' and ${task.expiresAt}>clock_timestamp() and ${run.status} in ('queued','running','waiting') and ${run.cancelRequestedAt} is null and (${run.deadlineAt} is null or ${run.deadlineAt}>clock_timestamp()))`,
    })
    .from(task)
    .innerJoin(
      run,
      and(eq(run.workspaceId, task.workspaceId), eq(run.id, task.runId)),
    )
    .where(predicate)
    .for('share', { of: task })
    .catch(rethrowQueryFailure);
  return {
    ...base,
    workflowId: row?.workflow_id ?? null,
    taskId: subject.subjectId,
    active: row?.pending ?? false,
    sourceRevision: subject.subjectId,
  };
}
async function readLimitReachedFact(
  client: PoolClient,
  subject: AttentionSubject,
): Promise<AttentionFact> {
  const [row] = await drizzle(client)
    .select({
      queue: sql<boolean>`coalesce(${entitlement.status}='active' and ${entitlement.effectiveAt}<=clock_timestamp() and (${entitlement.expiresAt} is null or ${entitlement.expiresAt}>clock_timestamp()) and counts.queued_runs>=${entitlement.queuedRunLimit},false)`,
      artifact_bytes: sql<boolean>`coalesce(${capacity.chargedBytes}>=${capacity.byteLimit},false)`,
      artifact_count: sql<boolean>`coalesce(${capacity.chargedCount}>=${capacity.artifactCountLimit},false)`,
    })
    .from(workspaces)
    .innerJoin(slotCounts, sql`true`)
    .leftJoin(pointer, eq(pointer.workspaceId, workspaces.id))
    .leftJoin(
      entitlement,
      and(
        eq(entitlement.workspaceId, pointer.workspaceId),
        eq(entitlement.version, pointer.currentVersion),
      ),
    )
    .leftJoin(capacity, eq(capacity.workspaceId, workspaces.id))
    .where(
      and(
        eq(workspaces.id, subject.workspaceId),
        eq(workspaces.status, 'active'),
      ),
    )
    .catch(rethrowQueryFailure);
  const limits = (
    ['queue', 'artifact_bytes', 'artifact_count'] as const
  ).filter((key) => row?.[key] ?? false);
  return {
    ...base,
    active: limits.length > 0,
    sourceRevision: limits.join(','),
  };
}
