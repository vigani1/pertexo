import type {
  WorkspaceCapacityLimit,
  WorkspaceNoticeKind,
} from '@pertexo/contracts';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import type { WorkspaceInboxThread } from '@pertexo/contracts';
import { databaseSchema } from '@pertexo/database/schema';
import { parseWorkspaceId } from '@pertexo/database/primitives';
import { readWorkflowRunFailedSteps } from '../../runs/queries/history/details.queries.js';
import { readFailureDays } from './failure-days.queries.js';
import type { WorkspaceInboxFailureKind } from './contract.js';
import type { NoticeRecord } from './records.queries.js';
type NoticeRow = NoticeRecord &
  (
    | {
        notice_kind: 'workflow_failure';
        workflow_id: string;
        workflow_name: string;
        latest_run_id: string;
        latest_kind: WorkspaceInboxFailureKind;
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
export async function projectNotices(
  client: PoolClient,
  workspaceId: string,
  records: readonly NoticeRecord[],
): Promise<readonly WorkspaceInboxThread[]> {
  // Subject/FK checks correlate the selected nullable columns with the notice kind.
  const rows = records as readonly NoticeRow[];
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
