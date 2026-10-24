import { rolesForCapability } from '@pertexo/workflow-model';
import { and, eq, sql, getTableColumns, type SQL } from 'drizzle-orm';
import { alias, type SelectedFieldsFlat } from 'drizzle-orm/pg-core';
import type { PublicationReview } from '@pertexo/contracts';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { workflowPublicationRequests } from '../../schema/authoring/publication-requests.js';
import {
  workflows,
  workflowDrafts,
  workflowVersions,
} from '../../schema/authoring/workflows.js';
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
export const reviewStateSql = sql<
  PublicationReview['status']
>`case when ${review.status}<>'pending' then ${review.status}
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
  return reviewSource(db, {
    id: review.id,
    workflowId: review.workflowId,
    active: sql<boolean>`((${reviewStateSql})='pending')`,
  });
}
export function reviewSource<T extends SelectedFieldsFlat>(
  db: Pick<NodePgDatabase, 'select'>,
  selection: T,
) {
  return db
    .select({ record: selection })
    .from(review)
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
    )
    .$dynamic();
}

export function reviewDetails(
  db: Pick<NodePgDatabase, 'select'>,
  actorId: string,
) {
  const actor = alias(workspaceMemberships, 'actor'),
    decider = alias(users, 'decider'),
    version = alias(workflowVersions, 'version');
  return reviewSource(db, {
    ...getTableColumns(review),
    draftGraph: draft.graphJson,
    workflowName: workflow.name,
    requesterName: requesterUser.displayName,
    deciderName: decider.displayName,
    versionNumber: version.versionNumber,
    state: reviewStateSql,
    canDecide: sql<boolean>`${reviewDecisionAllowedSql(sql`${actorId}`, sql`${actor.role}`)}`,
  })
    .leftJoin(decider, eq(decider.id, review.decidedBy))
    .leftJoin(
      version,
      and(
        eq(version.workspaceId, review.workspaceId),
        eq(version.id, review.publishedVersionId),
      ),
    )
    .innerJoin(
      actor,
      and(
        eq(actor.workspaceId, review.workspaceId),
        eq(actor.userId, actorId),
        eq(actor.status, 'active'),
      ),
    );
}
