import type { PoolClient } from 'pg';
import type { WorkspaceNoticeKind } from '@pertexo/contracts';
import { hasCapability, type Role } from '../tenant-access/policy.js';
import { pendingTaskBlockedSql } from '../runs/pending-tasks/queries.js';
export type NoticeSubjectRecord = Readonly<{
  id: string;
  notice_kind: WorkspaceNoticeKind;
  subject_id: string;
  workflow_id: string | null;
  connection_id: string | null;
  task_id: string | null;
  active: boolean;
  latest_occurred_at: Date;
}>;
/** This owner serves both discovery and dispatch; RLS is an additional data fence. */
export async function eligibleNoticeIds(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  role: Role,
  threads: readonly NoticeSubjectRecord[],
): Promise<ReadonlySet<string>> {
  if (threads.length === 0) return new Set();
  const choices = await client.query<{
    subject_kind: string;
    subject_id: string;
    followed: boolean;
    muted: boolean;
  }>(
    `select subject_kind,subject_id,followed,muted from app.notice_subscriptions where workspace_id=$1 and user_id=$2 and subject_id=any($3::uuid[])`,
    [
      workspaceId,
      actorId,
      threads.flatMap((t) =>
        [t.workflow_id, t.connection_id].filter(
          (id): id is string => id !== null,
        ),
      ),
    ],
  );
  const bySubject = new Map(
    choices.rows.map((s) => [`${s.subject_kind}:${s.subject_id}`, s]),
  );
  const approvals = threads
    .filter((t) => t.notice_kind === 'approval_waiting')
    .map((t) => t.task_id);
  const tasks =
    approvals.length === 0
      ? []
      : (
          await client.query<{ id: string }>(
            `select task.id from app.pending_run_tasks task join app.workflow_runs run on run.workspace_id=task.workspace_id and run.id=task.run_id where task.workspace_id=$1 and task.id=any($4::uuid[]) and (${pendingTaskBlockedSql('$2', '$3')}) is null`,
            [workspaceId, actorId, role, approvals],
          )
        ).rows;
  const allowedTasks = new Set(tasks.map((t) => t.id));
  return new Set(
    threads
      .filter((t) => {
        if (!t.active) return false;
        const workflow =
          t.workflow_id === null
            ? undefined
            : bySubject.get(`workflow:${t.workflow_id}`);
        const connection =
          t.connection_id === null
            ? undefined
            : bySubject.get(`connection:${t.connection_id}`);
        if (workflow?.muted === true || connection?.muted === true)
          return false;
        switch (t.notice_kind) {
          case 'workflow_failure':
            return (
              hasCapability(role, 'notification:read') ||
              workflow?.followed === true
            );
          case 'workflow_auto_paused':
            return (
              hasCapability(role, 'notification:read') ||
              workflow?.followed === true
            );
          case 'connection_attention':
            return role === 'owner' || role === 'admin';
          case 'limit_reached':
            return hasCapability(role, 'notification:read');
          case 'approval_waiting':
            return t.task_id !== null && allowedTasks.has(t.task_id);
        }
      })
      .map((t) => t.id),
  );
}
