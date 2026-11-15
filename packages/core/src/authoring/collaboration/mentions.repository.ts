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
import { generatePersistedId } from '@pertexo/database/platform';
import type { CollaborationScope } from './workflow-collaboration.types.js';
/** The active members among the mentioned people, with their roles, shared while the comment is written. */
export async function shareMentionedMembers(
  client: PoolClient,
  input: CollaborationScope,
  userIds: readonly string[],
) {
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
  return members;
}

/** Leaves exactly these people mentioned on the comment. */
export async function replaceCommentMentions(
  client: PoolClient,
  input: CollaborationScope,
  commentId: string,
  userIds: readonly string[],
) {
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
