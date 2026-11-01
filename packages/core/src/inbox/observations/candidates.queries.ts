import { entitlementInEffect } from '../../runs/queries/entitlement-effect.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { and, eq, notExists, sql, type SQLWrapper } from 'drizzle-orm';
import { union } from 'drizzle-orm/pg-core';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type { WorkspaceCapacityLimit } from '@pertexo/contracts';
import {
  workspaces,
  workflows,
  connections,
  workflowPublicationRequests,
  pendingRunTasks,
  workspaceInboxThreads as thread,
  workspaceArtifactCapacity as capacity,
  workspaceExecutionAdmissionCounters as counter,
  workspaceExecutionEntitlements as pointer,
  workspaceExecutionEntitlementVersions as entitlement,
  workflowCommentMentions as mention,
  workflowComments as comment,
} from '@pertexo/database/schema';
import { capacityWarningCandidates } from './capacity.queries.js';
import type { AttentionSubject } from './facts.queries.js';
import { NOTICE_WINDOW_SQL } from '../lifetime.js';
type Kind = AttentionSubject['noticeKind'];
const kind = (value: Kind) => sql<Kind>`${value}::varchar`.as('notice_kind');
const noLimit = sql<WorkspaceCapacityLimit | null>`null::varchar`.as(
  'capacity_limit',
);
export type Candidate = Readonly<{ workspace_id: string; subject_id: string }> &
  (
    | {
        notice_kind: 'limit_approaching';
        capacity_limit: WorkspaceCapacityLimit;
      }
    | { notice_kind: Exclude<Kind, 'limit_approaching'>; capacity_limit: null }
  );
type CandidateSource = ReturnType<typeof mentionCandidates>;

function workflowCandidates(db: Pick<NodePgDatabase, 'select'>) {
  const paused = db
    .select({
      workspace_id: workflows.workspaceId,
      notice_kind: kind('workflow_auto_paused'),
      subject_id: workflows.id,
      capacity_limit: noLimit,
    })
    .from(workflows)
    .where(eq(workflows.triggerPauseState, 'paused'));
  const connection = db
    .select({
      workspace_id: connections.workspaceId,
      notice_kind: kind('connection_attention'),
      subject_id: connections.id,
      capacity_limit: noLimit,
    })
    .from(connections)
    .where(eq(connections.status, 'reauthorization_required'));
  const review = db
    .select({
      workspace_id: workflowPublicationRequests.workspaceId,
      notice_kind: kind('publication_review_waiting'),
      subject_id: workflowPublicationRequests.id,
      capacity_limit: noLimit,
    })
    .from(workflowPublicationRequests)
    .where(eq(workflowPublicationRequests.status, 'pending'));
  const approval = db
    .select({
      workspace_id: pendingRunTasks.workspaceId,
      notice_kind: kind('approval_waiting'),
      subject_id: pendingRunTasks.id,
      capacity_limit: noLimit,
    })
    .from(pendingRunTasks)
    .where(
      and(
        eq(pendingRunTasks.kind, 'approval'),
        eq(pendingRunTasks.status, 'pending'),
      ),
    );
  return [paused, connection, review, approval];
}
/** The workspace itself as a notice's subject, named apart from its workspace column. */
const workspaceSubject = (workspaceId: SQLWrapper) =>
  sql<string>`${workspaceId}`.as('subject_id');

function capacityCandidates(db: Pick<NodePgDatabase, 'select'>) {
  const full = db
    .select({
      workspace_id: capacity.workspaceId,
      notice_kind: kind('limit_reached'),
      subject_id: workspaceSubject(capacity.workspaceId),
      capacity_limit: noLimit,
    })
    .from(capacity)
    .where(
      sql`${capacity.chargedBytes}>=${capacity.byteLimit} or ${capacity.chargedCount}>=${capacity.artifactCountLimit}`,
    );
  const queued = db
    .select({
      workspace_id: counter.workspaceId,
      notice_kind: kind('limit_reached'),
      subject_id: workspaceSubject(counter.workspaceId),
      capacity_limit: noLimit,
    })
    .from(counter)
    .innerJoin(pointer, eq(pointer.workspaceId, counter.workspaceId))
    .innerJoin(
      entitlement,
      and(
        eq(entitlement.workspaceId, pointer.workspaceId),
        eq(entitlement.version, pointer.currentVersion),
      ),
    )
    .where(
      sql`${counter.queuedRuns}>=${entitlement.queuedRunLimit} and ${entitlementInEffect(entitlement, sql`clock_timestamp()`)}`,
    );
  const warning = capacityWarningCandidates(db).as('warning');
  const approaching = db
    .select({
      workspace_id: warning.workspace_id,
      notice_kind: kind('limit_approaching'),
      subject_id: workspaceSubject(warning.workspace_id),
      capacity_limit: warning.capacity_limit,
    })
    .from(warning);
  return [full, queued, approaching];
}
function mentionCandidates(db: Pick<NodePgDatabase, 'select'>) {
  return db
    .select({
      workspace_id: mention.workspaceId,
      notice_kind: kind('workflow_mention'),
      subject_id: mention.id,
      capacity_limit: noLimit,
    })
    .from(mention)
    .innerJoin(
      comment,
      and(
        eq(comment.workspaceId, mention.workspaceId),
        eq(comment.id, mention.commentId),
      ),
    )
    .where(
      and(
        sql`${mention.createdAt}>clock_timestamp()-${NOTICE_WINDOW_SQL} and ${mention.userId} is distinct from ${comment.authorId}`,
        notExists(
          db
            .select({ id: thread.id })
            .from(thread)
            .where(
              and(
                eq(thread.workspaceId, mention.workspaceId),
                eq(thread.noticeKind, 'workflow_mention'),
                eq(thread.subjectId, mention.id),
              ),
            ),
        ),
      ),
    );
}
const ATTENTION_PAGE_SIZE = 100;

/**
 * One source's next page. A source is keyed by workspace and id, so this walks its
 * index and stops; the union then only sorts a page per source, not every subject.
 */
function sourcePage(
  db: Pick<NodePgDatabase, 'select'>,
  after: Candidate | undefined,
) {
  return (candidates: CandidateSource) => {
    const source = candidates.as('source');
    const key = sql`coalesce(${source.capacity_limit},'')`;
    return db
      .select({
        workspace_id: source.workspace_id,
        notice_kind: source.notice_kind,
        subject_id: source.subject_id,
        capacity_limit: source.capacity_limit,
      })
      .from(source)
      .innerJoin(workspaces, eq(workspaces.id, source.workspace_id))
      .where(
        and(
          eq(workspaces.status, 'active'),
          after === undefined
            ? undefined
            : sql`${source.workspace_id}>=${after.workspace_id}::uuid and (${source.workspace_id},${source.notice_kind},${source.subject_id},${key})>(${after.workspace_id}::uuid,${after.notice_kind}::varchar,${after.subject_id}::uuid,${after.capacity_limit ?? ''}::varchar)`,
        ),
      )
      .orderBy(source.workspace_id, source.notice_kind, source.subject_id, key)
      .limit(ATTENTION_PAGE_SIZE);
  };
}

export async function readAttentionCandidates(
  pool: Pool,
  after: Candidate | undefined,
): Promise<readonly Candidate[]> {
  const db = drizzle(pool);
  const existing = db
    .select({
      workspace_id: thread.workspaceId,
      notice_kind: sql<Kind>`${thread.noticeKind}`.as('notice_kind'),
      subject_id:
        sql<string>`case when ${thread.noticeKind}='limit_approaching' then ${thread.workspaceId} else ${thread.subjectId} end`.as(
          'subject_id',
        ),
      capacity_limit: thread.capacityLimit,
    })
    .from(thread)
    .where(
      sql`${thread.noticeKind}<>'workflow_failure' and ${thread.active} and (${thread.noticeKind}<>'workflow_mention' or ${thread.latestOccurredAt}<=clock_timestamp()-${NOTICE_WINDOW_SQL})`,
    );
  const page = sourcePage(db, after);
  // Every source selects the same columns; only the table behind them differs.
  const sources = [
    ...workflowCandidates(db),
    ...capacityCandidates(db),
    existing,
  ] as unknown as readonly CandidateSource[];
  const subjects = union(
    page(mentionCandidates(db)),
    ...(sources.map(page) as [ReturnType<typeof page>]),
  ).as('subject');
  const found = await db
    .select({
      workspace_id: subjects.workspace_id,
      notice_kind: subjects.notice_kind,
      subject_id: subjects.subject_id,
      capacity_limit: subjects.capacity_limit,
    })
    .from(subjects)
    .orderBy(
      subjects.workspace_id,
      subjects.notice_kind,
      subjects.subject_id,
      sql`coalesce(${subjects.capacity_limit},'')`,
    )
    .limit(ATTENTION_PAGE_SIZE)
    .catch(rethrowQueryFailure);
  // The union fixes the capacity key for limit_approaching and null for all other kinds.
  return found as Candidate[];
}
