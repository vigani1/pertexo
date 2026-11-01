import { NOTICE_WINDOW_SQL, windowedNoticeSql } from '../lifetime.js';
import { and, eq, exists, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FolderScope } from '../../tenant-access/resources/contract.js';
import { workflowScopeSql } from '../../shared/scope.queries.js';
import {
  rolesForCapability,
  type AuthorizationCapability,
} from '@pertexo/workflow-model';
import type { WorkspaceNoticeKind } from '@pertexo/contracts';
import {
  workspaceMemberships,
  noticeSubscriptions,
  workflowCommentMentions,
} from '@pertexo/database/schema';
import {
  review,
  reviewRecords,
  reviewDecisionAllowedSql,
} from '../../authoring/reviews/eligibility.queries.js';
import {
  task,
  run,
  pendingTaskBlockedSql,
} from '../../runs/pending-tasks/responses/eligibility.queries.js';
import { thread } from './records.queries.js';
const member = alias(workspaceMemberships, 'member');
function capabilityAudienceSql(capability: AuthorizationCapability): SQL {
  return sql`${member.role} in (${sql.join(
    rolesForCapability(capability).map((role) => sql`${role}`),
    sql`,`,
  )})`;
}
/** Query the audience before LIMIT, counts and writes; RLS supplies the isolation fence. */
export function noticeVisibilitySql(
  db: Pick<NodePgDatabase, 'select'>,
  actorId: string,
  resources: FolderScope,
): SQL {
  const actor = sql`${actorId}::uuid`;
  const operational = capabilityAudienceSql('notification:read');
  const workflowAudience = or(
    operational,
    exists(
      db
        .select({ one: sql`1` })
        .from(noticeSubscriptions)
        .where(
          and(
            eq(noticeSubscriptions.workspaceId, thread.workspaceId),
            eq(noticeSubscriptions.userId, actorId),
            eq(noticeSubscriptions.subjectKind, 'workflow'),
            eq(noticeSubscriptions.subjectId, thread.workflowId),
            eq(noticeSubscriptions.followed, true),
          ),
        ),
    ),
  );
  const audiences: Record<WorkspaceNoticeKind, SQL | undefined> = {
    workflow_failure: workflowAudience,
    workflow_auto_paused: workflowAudience,
    connection_attention: capabilityAudienceSql('connection:manage'),
    limit_reached: operational,
    limit_approaching: operational,
    workflow_mention: and(
      capabilityAudienceSql('workflow:read'),
      exists(
        db
          .select({ one: sql`1` })
          .from(workflowCommentMentions)
          .where(
            and(
              eq(workflowCommentMentions.workspaceId, thread.workspaceId),
              eq(workflowCommentMentions.id, thread.commentMentionId),
              eq(workflowCommentMentions.userId, actorId),
            ),
          ),
      ),
    ),
    publication_review_waiting: exists(
      reviewRecords(db).where(
        and(
          eq(review.workspaceId, thread.workspaceId),
          eq(review.id, thread.publicationRequestId),
          reviewDecisionAllowedSql(actor, sql`${member.role}`),
        ),
      ),
    ),
    approval_waiting: exists(
      db
        .select({ one: sql`1` })
        .from(task)
        .innerJoin(
          run,
          and(eq(run.workspaceId, task.workspaceId), eq(run.id, task.runId)),
        )
        .where(
          and(
            eq(task.workspaceId, thread.workspaceId),
            eq(task.id, thread.taskId),
            eq(task.kind, 'approval'),
            isNull(pendingTaskBlockedSql(actor, sql`${member.role}`)),
          ),
        ),
    ),
  };
  const muted = exists(
    db
      .select({ one: sql`1` })
      .from(noticeSubscriptions)
      .where(
        and(
          eq(noticeSubscriptions.workspaceId, thread.workspaceId),
          eq(noticeSubscriptions.userId, actorId),
          eq(noticeSubscriptions.muted, true),
          or(
            and(
              eq(noticeSubscriptions.subjectKind, 'workflow'),
              eq(noticeSubscriptions.subjectId, thread.workflowId),
            ),
            and(
              eq(noticeSubscriptions.subjectKind, 'connection'),
              eq(noticeSubscriptions.subjectId, thread.connectionId),
            ),
          ),
        ),
      ),
  );
  return sql`${resources.role !== null} and (${thread.workflowId} is null or (${workflowScopeSql(resources, sql`${thread.workflowId}`)})) and ${thread.active}
 and (not ${windowedNoticeSql(thread.noticeKind)} or ${thread.latestOccurredAt}>statement_timestamp()-${NOTICE_WINDOW_SQL})
 and not (${muted}) and ${exists(
   db
     .select({ one: sql`1` })
     .from(member)
     .where(
       and(
         eq(member.workspaceId, thread.workspaceId),
         eq(member.userId, actorId),
         eq(member.status, 'active'),
         sql`case ${thread.noticeKind} ${sql.join(
           Object.entries(audiences).map(
             ([kind, predicate]) => sql`when ${kind} then (${predicate})`,
           ),
           sql` `,
         )} else false end`,
       ),
     ),
 )}`;
}
