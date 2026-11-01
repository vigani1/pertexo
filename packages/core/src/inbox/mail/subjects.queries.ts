import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { readFolderScope } from '../../shared/facts.queries.js';
import { NOTICE_WINDOW_SQL } from '../lifetime.js';
import { and, eq, gt, inArray, isNull, notExists, or, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  noticeSubscriptions as sub,
  noticeMailItems as item,
  noticeMailBatches as batch,
  systemMailDeliveries as delivery,
} from '@pertexo/database/schema';
import {
  thread,
  workspace,
  workflow,
  connection,
  mention,
  comment,
} from '../threads/records.queries.js';
import type { PoolClient } from 'pg';
import type {
  WorkspaceCapacityLimit,
  WorkspaceNoticeKind,
} from '@pertexo/contracts';
import { noticeVisibilitySql } from '../threads/eligibility.queries.js';
import {
  connectionNeedsAttentionSql,
  readAttentionFact,
} from '../observations/facts.queries.js';
const SUBJECTS_PER_MAIL = 100;
type MailSubjectRecord = Awaited<ReturnType<typeof mailSubjectsQuery>>[number];
export type MailSubjectRow = MailSubjectRecord &
  (
    | Readonly<{
        notice_kind: 'limit_approaching';
        capacity_limit: WorkspaceCapacityLimit;
        comment_id: null;
        comment_thread_id: null;
      }>
    | Readonly<{
        notice_kind: 'workflow_mention';
        capacity_limit: null;
        workflow_id: string;
        comment_id: string;
        comment_thread_id: string;
      }>
    | Readonly<{
        notice_kind: Exclude<
          WorkspaceNoticeKind,
          'limit_approaching' | 'workflow_mention'
        >;
        capacity_limit: null;
        comment_id: null;
        comment_thread_id: null;
      }>
  );
/** Bounded current subjects; no run values, errors or task instructions are selected. */
export async function readMailSubjects(
  client: PoolClient,
  workspaceId: string,
  {
    actorId,
    cut,
    onlyIds,
  }: Readonly<{
    actorId: string;
    cut: Date;
    onlyIds?: readonly string[] | undefined;
  }>,
): Promise<readonly MailSubjectRow[]> {
  const resources = await readFolderScope(client, { workspaceId, actorId });
  const db = drizzle(client);
  const found = await mailSubjectsQuery(db, actorId)
    .where(
      and(
        eq(thread.workspaceId, workspaceId),
        noticeVisibilitySql(db, actorId, resources),
        sql`${thread.latestOccurredAt}>${cut}::timestamptz`,
        sql`${thread.latestOccurredAt}>clock_timestamp()-${NOTICE_WINDOW_SQL}`,
        or(
          isNull(sub.changedAt),
          gt(thread.latestOccurredAt, sql`${sub.changedAt}`),
        ),
        onlyIds === undefined ? undefined : inArray(thread.id, [...onlyIds]),
        or(
          eq(thread.noticeKind, 'workflow_failure'),
          and(
            eq(thread.noticeKind, 'workflow_auto_paused'),
            eq(workflow.triggerPauseState, 'paused'),
          ),
          and(
            eq(thread.noticeKind, 'connection_attention'),
            connectionNeedsAttentionSql(connection),
          ),
          inArray(thread.noticeKind, [
            'limit_reached',
            'limit_approaching',
            'approval_waiting',
            'publication_review_waiting',
            'workflow_mention',
          ]),
        ),
        onlyIds === undefined
          ? notExists(
              db
                .select({ one: sql`1` })
                .from(item)
                .innerJoin(
                  batch,
                  and(
                    eq(batch.workspaceId, item.workspaceId),
                    eq(batch.id, item.batchId),
                  ),
                )
                .innerJoin(delivery, eq(delivery.id, batch.id))
                .where(
                  and(
                    eq(item.workspaceId, thread.workspaceId),
                    eq(item.threadId, thread.id),
                    sql`${item.revision}>=${thread.revision}`,
                    eq(batch.userId, actorId),
                    isNull(batch.releasedAt),
                  ),
                ),
            )
          : undefined,
      ),
    )
    .orderBy(thread.latestOccurredAt, thread.id)
    .limit(SUBJECTS_PER_MAIL)
    .catch(rethrowQueryFailure);
  const current: MailSubjectRow[] = [];
  // Audience and task eligibility filter before LIMIT; capacity facts are rechecked before use.
  // Subject/FK checks correlate the nullable columns with the notice kind.
  for (const row of found as MailSubjectRow[]) {
    if (
      row.notice_kind === 'limit_reached' ||
      row.notice_kind === 'limit_approaching'
    ) {
      const scope = { workspaceId, subjectId: row.subject_id };
      const fact = await readAttentionFact(
        client,
        row.notice_kind === 'limit_approaching'
          ? {
              ...scope,
              noticeKind: row.notice_kind,
              capacityLimit: row.capacity_limit,
            }
          : { ...scope, noticeKind: row.notice_kind },
      );
      if (!fact.active) continue;
    }
    current.push(row);
  }
  return current;
}
function mailSubjectsQuery(
  db: Pick<NodePgDatabase, 'select'>,
  actorId: string,
) {
  return db
    .select({
      id: thread.id,
      notice_kind: thread.noticeKind,
      subject_id: thread.subjectId,
      workflow_id: thread.workflowId,
      revision: sql<string>`${thread.revision}::text`,
      occurrence_count: sql<string>`${thread.occurrenceCount}::text`,
      capacity_limit: thread.capacityLimit,
      comment_id: comment.id,
      comment_thread_id: comment.threadId,
      name: sql<string>`coalesce(${workflow.name},${connection.name},${workspace.name})`,
    })
    .from(thread)
    .innerJoin(workspace, eq(workspace.id, thread.workspaceId))
    .leftJoin(
      workflow,
      and(
        eq(workflow.workspaceId, thread.workspaceId),
        eq(workflow.id, thread.workflowId),
      ),
    )
    .leftJoin(
      connection,
      and(
        eq(connection.workspaceId, thread.workspaceId),
        eq(connection.id, thread.connectionId),
      ),
    )
    .leftJoin(
      mention,
      and(
        eq(mention.workspaceId, thread.workspaceId),
        eq(mention.id, thread.commentMentionId),
      ),
    )
    .leftJoin(
      comment,
      and(
        eq(comment.workspaceId, mention.workspaceId),
        eq(comment.id, mention.commentId),
      ),
    )
    .leftJoin(
      sub,
      and(
        eq(sub.workspaceId, thread.workspaceId),
        eq(sub.userId, actorId),
        or(
          and(
            eq(sub.subjectKind, 'workflow'),
            eq(sub.subjectId, thread.workflowId),
          ),
          and(
            eq(sub.subjectKind, 'connection'),
            eq(sub.subjectId, thread.connectionId),
          ),
        ),
      ),
    );
}
