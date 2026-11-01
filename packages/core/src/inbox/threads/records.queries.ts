import type {
  WorkspaceInboxThread,
  WorkspaceCapacityLimit,
} from '@pertexo/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  workspaceInboxThreads,
  workspaceInboxReads,
  workspaces,
  workflows,
  connections,
  workflowCommentMentions,
  workflowComments,
} from '@pertexo/database/schema';
import { task } from '../../runs/pending-tasks/responses/eligibility.queries.js';
export const thread = alias(workspaceInboxThreads, 'thread');
export const seen = alias(workspaceInboxReads, 'seen');
export const workspace = alias(workspaces, 'workspace');
export const workflow = alias(workflows, 'workflow');
export const connection = alias(connections, 'connection');
export const mention = alias(workflowCommentMentions, 'mention');
export const comment = alias(workflowComments, 'comment');
export const unreadSql = sql<boolean>`(${seen.readRevision} is null or ${seen.readRevision}<${thread.revision})`;
const noticeFields = {
  id: thread.id,
  notice_kind: thread.noticeKind,
  subject_id: thread.subjectId,
  workflow_id: thread.workflowId,
  workflow_name: workflow.name,
  connection_name: connection.name,
  workspace_name: workspace.name,
  latest_kind: thread.latestKind,
  occurrence_count: sql<string>`${thread.occurrenceCount}::text`,
  capacity_limits: sql<
    WorkspaceCapacityLimit[] | null
  >`string_to_array(${thread.sourceRevision},',')`,
  capacity_limit: thread.capacityLimit,
  comment_id: comment.id,
  comment_thread_id: comment.threadId,
  task_details: sql<
    | Exclude<
        WorkspaceInboxThread,
        { noticeKind: 'workflow_failure' }
      >['details']
    | null
  >`${task.context}->'details'`,
  first_occurred_at: sql<string>`to_char(${thread.firstOccurredAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  latest_occurred_at: sql<string>`to_char(${thread.latestOccurredAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  latest_run_id: thread.latestRunId,
  revision: sql<string>`${thread.revision}::text`,
  unread: unreadSql,
};
export function noticeRecords(
  db: Pick<NodePgDatabase, 'select'>,
  actorId: string,
) {
  return db
    .select(noticeFields)
    .from(thread)
    .$dynamic()
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
      task,
      and(eq(task.workspaceId, thread.workspaceId), eq(task.id, thread.taskId)),
    )
    .leftJoin(
      seen,
      and(
        eq(seen.workspaceId, thread.workspaceId),
        eq(seen.threadId, thread.id),
        eq(seen.userId, actorId),
      ),
    );
}
export type NoticeRecord = Awaited<ReturnType<typeof noticeRecords>>[number];
