import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import {
  workspaceMemberships,
  users,
  workflowCommentMentions,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import { hasCapability } from '@pertexo/workflow-model';
import { generatePersistedId } from '@pertexo/database/platform';
import { WorkflowCollaborationError } from './errors.js';
import type { CollaborationScope } from './contract.js';
export async function syncCommentMentions(
  client: PoolClient,
  input: CollaborationScope,
  commentId: string,
  userIds: readonly string[],
) {
  if (userIds.length > 0) {
    const member = alias(workspaceMemberships, 'member'),
      actor = alias(users, 'actor');
    const members = await drizzle(client)
      .select({ userId: member.userId, role: member.role })
      .from(member)
      .innerJoin(actor, eq(actor.id, member.userId))
      .where(
        and(
          eq(member.workspaceId, input.workspaceId),
          inArray(member.userId, userIds),
          eq(member.status, 'active'),
          eq(actor.status, 'active'),
        ),
      )
      .for('share', { of: [member, actor] })
      .catch(rethrowQueryFailure);
    if (
      members.length !== userIds.length ||
      members.some((member) => !hasCapability(member.role, 'workflow:read'))
    )
      throw new WorkflowCollaborationError(
        'conflict',
        'A mentioned person no longer has access. Remove them and review the comment before trying again.',
      );
  }
  const db = drizzle(client);
  await db
    .delete(workflowCommentMentions)
    .where(
      and(
        eq(workflowCommentMentions.workspaceId, input.workspaceId),
        eq(workflowCommentMentions.commentId, commentId),
        notInArray(workflowCommentMentions.userId, [...userIds]),
      ),
    )
    .catch(rethrowQueryFailure);
  for (const userId of userIds)
    await db
      .insert(workflowCommentMentions)
      .values({
        workspaceId: input.workspaceId,
        id: generatePersistedId(),
        commentId,
        userId,
      })
      .onConflictDoNothing({
        target: [
          workflowCommentMentions.workspaceId,
          workflowCommentMentions.commentId,
          workflowCommentMentions.userId,
        ],
      })
      .catch(rethrowQueryFailure);
}
