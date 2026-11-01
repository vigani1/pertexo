import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { alias } from 'drizzle-orm/pg-core';
import { NOTICE_WINDOW_SQL } from '../lifetime.js';
import {
  workflowCommentThreads as discussion,
  workflowCommentMentions as mentionsTable,
  workflowComments as commentsTable,
  workflows,
} from '@pertexo/database/schema';
import type { PoolClient } from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
const comment = alias(commentsTable, 'comment');
const mention = alias(mentionsTable, 'mention');
/** Match the authoring lock order before the FK acquires mention locks. */
export async function readCommentMentionSource(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; subjectId: string }>,
) {
  const db = drizzle(client);
  const predicate = and(
    eq(mention.workspaceId, input.workspaceId),
    eq(mention.id, input.subjectId),
  );
  const join = and(
    eq(comment.workspaceId, mention.workspaceId),
    eq(comment.id, mention.commentId),
  );
  const [first] = await db
    .select({ workflowId: discussion.workflowId, threadId: discussion.id })
    .from(mention)
    .innerJoin(comment, join)
    .innerJoin(
      discussion,
      and(
        eq(discussion.workspaceId, comment.workspaceId),
        eq(discussion.id, comment.threadId),
      ),
    )
    .where(predicate)
    .catch(rethrowQueryFailure);
  if (first === undefined) return null;
  const workflow = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, first.workflowId),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  if (workflow.length !== 1) return null;
  const locked = await db
    .select({ id: discussion.id })
    .from(discussion)
    .where(
      and(
        eq(discussion.workspaceId, input.workspaceId),
        eq(discussion.id, first.threadId),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  if (locked.length !== 1) return null;
  const [source] = await db
    .select({
      createdAt: mention.createdAt,
      active: sql<boolean>`(${mention.createdAt}>clock_timestamp()-${NOTICE_WINDOW_SQL} and ${mention.userId} is distinct from ${comment.authorId})`,
    })
    .from(mention)
    .innerJoin(comment, join)
    .where(and(predicate, eq(comment.threadId, first.threadId)))
    .for('share', { of: [comment, mention] })
    .catch(rethrowQueryFailure);
  return source === undefined
    ? null
    : {
        workflowId: first.workflowId,
        occurredAt: source.createdAt,
        active: source.active,
      };
}
