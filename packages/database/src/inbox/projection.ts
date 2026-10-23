import type {
  WorkspaceCapacityLimit,
  WorkspaceNoticeKind,
} from '@pertexo/contracts';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import type { WorkspaceInboxThread } from '@pertexo/contracts';
import { databaseSchema } from '../schema.js';
import { parseWorkspaceId } from '../tenant-access/transactions.js';
import { readWorkflowRunFailedSteps } from '../runs/queries/history/details.js';
import { readFailureDays } from './failure-days.js';
type Attention = Exclude<
  WorkspaceInboxThread,
  { noticeKind: 'workflow_failure' }
>;
type NoticeFields = Readonly<{
  id: string;
  subject_id: string;
  workflow_id: string | null;
  workflow_name: string | null;
  connection_name: string | null;
  workspace_name: string;
  occurrence_count: string;
  first_occurred_at: string;
  latest_occurred_at: string;
  latest_run_id: string | null;
  latest_kind: string | null;
  revision: string;
  unread: boolean;
  task_details: Attention['details'] | null;
  capacity_limit: WorkspaceCapacityLimit | null;
  capacity_limits: WorkspaceCapacityLimit[] | null;
  comment_id: string | null;
  comment_thread_id: string | null;
}>;
export type NoticeRow = NoticeFields &
  (
    | {
        notice_kind: 'workflow_failure';
        workflow_id: string;
        workflow_name: string;
        latest_run_id: string;
        latest_kind: 'failed' | 'timed_out' | 'outcome_unknown';
      }
    | {
        notice_kind: 'workflow_mention';
        workflow_id: string;
        comment_id: string;
        comment_thread_id: string;
      }
    | {
        notice_kind: Exclude<
          WorkspaceNoticeKind,
          'workflow_failure' | 'workflow_mention' | 'limit_approaching'
        >;
      }
    | {
        notice_kind: 'limit_approaching';
        capacity_limit: WorkspaceCapacityLimit;
      }
  );
export const noticeColumns = `thread.id,thread.notice_kind,thread.subject_id,thread.workflow_id,workflow.name workflow_name,connection.name connection_name,workspace.name workspace_name,thread.latest_kind,thread.occurrence_count::text,string_to_array(thread.source_revision,',') capacity_limits,thread.capacity_limit,comment.id comment_id,comment.thread_id comment_thread_id,
 task.context->'details' task_details,to_char(thread.first_occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') first_occurred_at,
 to_char(thread.latest_occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') latest_occurred_at,
 thread.latest_run_id,thread.revision::text,(seen.read_revision is null or seen.read_revision<thread.revision) unread`;
export const noticeSource = `from app.workspace_inbox_threads thread
 join app.workspaces workspace on workspace.id=thread.workspace_id
 left join app.workflows workflow on workflow.workspace_id=thread.workspace_id and workflow.id=thread.workflow_id
 left join app.connections connection on connection.workspace_id=thread.workspace_id and connection.id=thread.connection_id
 left join app.workflow_comment_mentions mention on mention.workspace_id=thread.workspace_id and mention.id=thread.comment_mention_id
 left join app.workflow_comments comment on comment.workspace_id=mention.workspace_id and comment.id=mention.comment_id
 left join app.pending_run_tasks task on task.workspace_id=thread.workspace_id and task.id=thread.task_id
 left join app.workspace_inbox_reads seen on seen.workspace_id=thread.workspace_id and seen.thread_id=thread.id and seen.user_id=$2`;
export async function projectNotices(
  client: PoolClient,
  workspaceId: string,
  rows: readonly NoticeRow[],
): Promise<readonly WorkspaceInboxThread[]> {
  const failures = rows.filter((row) => row.notice_kind === 'workflow_failure');
  const runIds = failures.map((row) => row.latest_run_id);
  const db = drizzle(client, { schema: databaseSchema });
  const steps = await readWorkflowRunFailedSteps(
    { db, workspaceId: parseWorkspaceId(workspaceId) },
    runIds,
  );
  const days = await readFailureDays(
    db,
    workspaceId,
    failures.map((row) => row.workflow_id),
  );
  return rows.map((row): WorkspaceInboxThread => {
    const common = {
      id: row.id,
      occurrenceCount: Number(row.occurrence_count),
      firstOccurredAt: row.first_occurred_at,
      latestOccurredAt: row.latest_occurred_at,
      revision: row.revision,
      unread: row.unread,
    };
    if (row.notice_kind === 'workflow_failure')
      return {
        ...common,
        noticeKind: row.notice_kind,
        workflowId: row.workflow_id,
        workflowName: row.workflow_name,
        kind: row.latest_kind,
        latestRunId: row.latest_run_id,
        latestFailedStep: steps.get(row.latest_run_id) ?? null,
        failureDays: [...(days.get(row.workflow_id) ?? [])],
      };
    const attention = {
      ...common,
      subjectId: row.subject_id,
      name: row.workflow_name ?? row.connection_name ?? row.workspace_name,
    };
    if (row.notice_kind === 'workflow_mention')
      return {
        ...attention,
        noticeKind: row.notice_kind,
        workflowId: row.workflow_id,
        threadId: row.comment_thread_id,
        commentId: row.comment_id,
        details: {},
        limits: [],
      };
    let limits: WorkspaceCapacityLimit[] = [];
    if (row.notice_kind === 'limit_approaching') limits = [row.capacity_limit];
    if (row.notice_kind === 'limit_reached') limits = row.capacity_limits ?? [];
    return {
      ...attention,
      noticeKind: row.notice_kind,
      workflowId: row.workflow_id,
      details:
        row.notice_kind === 'approval_waiting' ? (row.task_details ?? {}) : {},
      limits,
    };
  });
}
