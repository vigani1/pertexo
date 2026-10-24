import { rolesForCapability } from '@pertexo/workflow-model';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { workflowPublicationRequests } from '../../schema/authoring/publication-requests.js';
import { workflows, workflowDrafts } from '../../schema/authoring/workflows.js';
import {
  workspaces,
  users,
  workspaceMemberships,
} from '../../schema/foundation.js';
export const review = alias(workflowPublicationRequests, 'review');
const workspace = alias(workspaces, 'workspace');
const workflow = alias(workflows, 'workflow');
const draft = alias(workflowDrafts, 'draft');
const requesterUser = alias(users, 'requester_user');
const requester = alias(workspaceMemberships, 'requester');
/** Fixed source aliases are shared by review reads, decisions and inbox audiences. */
export const REVIEW_SOURCE_SQL = `from app.workflow_publication_requests review
 join app.workspaces workspace on workspace.id=review.workspace_id
 join app.workflows workflow on workflow.workspace_id=review.workspace_id and workflow.id=review.workflow_id
 join app.workflow_drafts draft on draft.workspace_id=review.workspace_id and draft.workflow_id=review.workflow_id
 join app.users requester_user on requester_user.id=review.requested_by
 left join app.workspace_memberships requester on requester.workspace_id=review.workspace_id and requester.user_id=review.requested_by`;

export const reviewStateSql = sql`case when ${review.status}<>'pending' then ${review.status}
 when ${review.expiresAt}<=clock_timestamp() then 'expired'
 when not ${workspace.requirePublishApproval} or ${workspace.status}<>'active' or ${workflow.lifecycleStatus}<>'active'
   or ${draft.revision}<>${review.draftRevision} or ${requesterUser.status}<>'active'
   or ${requester.status} is distinct from 'active' or ${requester.role} not in (${sql.join(
     rolesForCapability('workflow:publish').map((role) => sql`${role}`),
     sql`,`,
   )}) then 'stale'
 else 'pending' end`;
export function reviewDecisionAllowedSql(actor: SQL, role: SQL): SQL {
  return sql`((${reviewStateSql})='pending' and ${review.requestedBy}<>${actor}::uuid and ${role} in (${sql.join(
    rolesForCapability('governance:manage').map((role) => sql`${role}`),
    sql`,`,
  )}))`;
}
export function reviewRecords(db: Pick<NodePgDatabase, 'select'>) {
  return db
    .select({
      id: review.id,
      workflowId: review.workflowId,
      active: sql<boolean>`((${reviewStateSql})='pending')`,
    })
    .from(review)
    .$dynamic()
    .innerJoin(workspace, eq(workspace.id, review.workspaceId))
    .innerJoin(
      workflow,
      and(
        eq(workflow.workspaceId, review.workspaceId),
        eq(workflow.id, review.workflowId),
      ),
    )
    .innerJoin(
      draft,
      and(
        eq(draft.workspaceId, review.workspaceId),
        eq(draft.workflowId, review.workflowId),
      ),
    )
    .innerJoin(requesterUser, eq(requesterUser.id, review.requestedBy))
    .leftJoin(
      requester,
      and(
        eq(requester.workspaceId, review.workspaceId),
        eq(requester.userId, review.requestedBy),
      ),
    );
}
