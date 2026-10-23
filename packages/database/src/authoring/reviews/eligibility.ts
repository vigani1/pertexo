import { rolesForCapability } from '@pertexo/workflow-model';

const authors = rolesForCapability('workflow:publish')
  .map((role) => `'${role}'`)
  .join(',');
const reviewers = rolesForCapability('governance:manage')
  .map((role) => `'${role}'`)
  .join(',');
/** Fixed source aliases are shared by review reads, decisions and inbox audiences. */
export const REVIEW_SOURCE_SQL = `from app.workflow_publication_requests review
 join app.workspaces workspace on workspace.id=review.workspace_id
 join app.workflows workflow on workflow.workspace_id=review.workspace_id and workflow.id=review.workflow_id
 join app.workflow_drafts draft on draft.workspace_id=review.workspace_id and draft.workflow_id=review.workflow_id
 join app.users requester_user on requester_user.id=review.requested_by
 left join app.workspace_memberships requester on requester.workspace_id=review.workspace_id and requester.user_id=review.requested_by`;
export const REVIEW_STATE_SQL = `case when review.status<>'pending' then review.status
 when review.expires_at<=clock_timestamp() then 'expired'
 when not workspace.require_publish_approval or workspace.status<>'active' or workflow.lifecycle_status<>'active'
   or draft.revision<>review.draft_revision or requester_user.status<>'active'
   or requester.status is distinct from 'active' or requester.role not in (${authors}) then 'stale'
 else 'pending' end`;
export function reviewDecisionAllowedSql(
  actorParameter: string,
  roleExpression: string,
): string {
  return `((${REVIEW_STATE_SQL})='pending' and review.requested_by<>${actorParameter}::uuid and ${roleExpression} in (${reviewers}))`;
}
