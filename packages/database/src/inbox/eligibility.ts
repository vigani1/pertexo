import { sql } from 'drizzle-orm';
import type { FolderScope } from '../tenant-access/resources/contract.js';
import {
  bindResourcePredicate,
  workflowScopeSql,
} from '../tenant-access/resources/query-scope.js';
import { NOTICE_WINDOW_SQL } from './lifetime.js';
import {
  REVIEW_SOURCE_SQL,
  reviewDecisionAllowedSql,
} from '../authoring/reviews/eligibility.js';
import type { WorkspaceNoticeKind } from '@pertexo/contracts';
import {
  rolesForCapability,
  type AuthorizationCapability,
} from '@pertexo/workflow-model';
import { pendingTaskBlockedSql } from '../runs/pending-tasks/responses/eligibility.js';

function capabilityAudienceSql(capability: AuthorizationCapability): string {
  const roles = rolesForCapability(capability)
    .map((role) => `'${role}'`)
    .join(',');
  return `member.role in (${roles})`;
}

/** Query the audience before LIMIT, counts and writes; RLS only supplies the isolation fence. */
export function noticeVisibilitySql(
  actorParameter: string,
  resources: FolderScope,
  parameters: unknown[],
): string {
  const visible = bindResourcePredicate(
    workflowScopeSql(resources, sql`thread.workflow_id`),
    parameters,
  );
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
    workflow_mention: `(${capabilityAudienceSql('workflow:read')} and exists(select 1 from app.workflow_comment_mentions mention where mention.workspace_id=thread.workspace_id and mention.id=thread.comment_mention_id and mention.user_id=${actorParameter}::uuid))`,
    publication_review_waiting: `exists(select 1 ${REVIEW_SOURCE_SQL} where review.workspace_id=thread.workspace_id and review.id=thread.publication_request_id and ${reviewDecisionAllowedSql(actorParameter, 'member.role')})`,
    approval_waiting: `exists(select 1 from app.pending_run_tasks task join app.workflow_runs run
      on run.workspace_id=task.workspace_id and run.id=task.run_id
      where task.workspace_id=thread.workspace_id and task.id=thread.task_id and task.kind='approval'
      and (${pendingTaskBlockedSql(actorParameter, 'member.role')}) is null)`,
  };
  return `${resources.role === null ? 'false' : 'true'} and (thread.workflow_id is null or (${visible})) and thread.active
    and (thread.notice_kind not in ('workflow_failure','workflow_mention') or thread.latest_occurred_at>statement_timestamp()-${NOTICE_WINDOW_SQL})
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
