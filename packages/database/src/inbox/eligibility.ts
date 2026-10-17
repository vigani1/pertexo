import {
  REVIEW_SOURCE_SQL,
  reviewDecisionAllowedSql,
} from '../authoring/reviews/eligibility.js';
import type { WorkspaceNoticeKind } from '@pertexo/contracts';
import {
  rolesForCapability,
  type AuthorizationCapability,
} from '../tenant-access/policy.js';
import { pendingTaskBlockedSql } from '../runs/pending-tasks/eligibility.js';

function capabilityAudienceSql(capability: AuthorizationCapability): string {
  const roles = rolesForCapability(capability)
    .map((role) => `'${role}'`)
    .join(',');
  return `member.role in (${roles})`;
}

/** Query the audience before LIMIT, counts and writes; RLS only supplies the isolation fence. */
export function noticeVisibilitySql(actorParameter: string): string {
  const operational = capabilityAudienceSql('notification:read');
  const workflow = `(${operational} or exists(select 1 from app.notice_subscriptions follow
    where follow.workspace_id=thread.workspace_id and follow.user_id=${actorParameter}::uuid
    and follow.subject_kind='workflow' and follow.subject_id=thread.workflow_id and follow.followed))`;
  const audiences: Record<WorkspaceNoticeKind, string> = {
    workflow_failure: workflow,
    workflow_auto_paused: workflow,
    connection_attention: capabilityAudienceSql('connection:manage'),
    limit_reached: operational,
    limit_approaching: operational,
    publication_review_waiting: `exists(select 1 ${REVIEW_SOURCE_SQL} where review.workspace_id=thread.workspace_id and review.id=thread.publication_request_id and ${reviewDecisionAllowedSql(actorParameter, 'member.role')})`,
    approval_waiting: `exists(select 1 from app.pending_run_tasks task join app.workflow_runs run
      on run.workspace_id=task.workspace_id and run.id=task.run_id
      where task.workspace_id=thread.workspace_id and task.id=thread.task_id and task.kind='approval'
      and (${pendingTaskBlockedSql(actorParameter, 'member.role')}) is null)`,
  };
  return `thread.active
    and (thread.notice_kind<>'workflow_failure' or thread.latest_occurred_at>statement_timestamp()-interval '720 hours')
    and not exists(select 1 from app.notice_subscriptions muted
      where muted.workspace_id=thread.workspace_id and muted.user_id=${actorParameter}::uuid and muted.muted
      and ((muted.subject_kind='workflow' and muted.subject_id=thread.workflow_id)
        or (muted.subject_kind='connection' and muted.subject_id=thread.connection_id)))
    and exists(select 1 from app.workspace_memberships member
      where member.workspace_id=thread.workspace_id and member.user_id=${actorParameter}::uuid and member.status='active'
      and case thread.notice_kind ${Object.entries(audiences)
        .map(([kind, predicate]) => `when '${kind}' then (${predicate})`)
        .join(' ')} else false end)`;
}
