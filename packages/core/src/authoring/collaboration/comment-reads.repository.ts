import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lt,
  lte,
  sql,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import {
  workflowCommentThreads,
  workflowComments,
  workflowCommentMentions,
  users,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { WorkflowComment } from '@pertexo/contracts';
import type {
  ListCommentsInput,
  ReadThreadInput,
} from './workflow-collaboration.types.js';
const preview = new QueryBuilder()
  .select({ body: sql<string>`left(${workflowComments.body},200)` })
  .from(workflowComments)
  .where(
    and(
      eq(workflowComments.workspaceId, workflowCommentThreads.workspaceId),
      eq(workflowComments.threadId, workflowCommentThreads.id),
    ),
  )
  .orderBy(desc(workflowComments.id))
  .limit(1);
const threadProjection = {
  ...getTableColumns(workflowCommentThreads),
  preview: sql<string | null>`(${preview})`,
};
const commentProjection = {
  ...getTableColumns(workflowComments),
  authorName: sql<string>`coalesce(${users.displayName},'Former member')`,
};
type StoredComment = typeof workflowComments.$inferSelect & {
  authorName: string;
};
export async function projectComments(
  client: PoolClient,
  workspaceId: string,
  rows: readonly StoredComment[],
): Promise<WorkflowComment[]> {
  const mentions = await drizzle(client)
    .select({
      commentId: workflowCommentMentions.commentId,
      userId: workflowCommentMentions.userId,
      displayName: users.displayName,
    })
    .from(workflowCommentMentions)
    .innerJoin(users, eq(users.id, workflowCommentMentions.userId))
    .where(
      and(
        eq(workflowCommentMentions.workspaceId, workspaceId),
        inArray(
          workflowCommentMentions.commentId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .orderBy(asc(workflowCommentMentions.id))
    .catch(rethrowQueryFailure);
  const byComment = new Map<
    string,
    { userId: string; displayName: string }[]
  >();
  for (const mention of mentions) {
    const people = byComment.get(mention.commentId) ?? [];
    people.push({ userId: mention.userId, displayName: mention.displayName });
    byComment.set(mention.commentId, people);
  }
  return rows.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    authorId: row.authorId,
    authorName: row.authorName,
    body: row.body,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    mentions: byComment.get(row.id) ?? [],
  }));
}
function threadScope(input: ListCommentsInput) {
  switch (input.scope) {
    case 'all':
      return undefined;
    case 'workflow':
      return isNull(workflowCommentThreads.stepId);
    case 'step':
      return eq(workflowCommentThreads.stepId, sql`${input.stepId}::varchar`);
  }
}

/** One page of the workflow's threads, one past the limit to tell if more follow. */
export async function listThreadRows(
  client: PoolClient,
  input: ListCommentsInput,
) {
  const found = await drizzle(client)
    .select(threadProjection)
    .from(workflowCommentThreads)
    .where(
      and(
        eq(workflowCommentThreads.workspaceId, input.workspaceId),
        eq(workflowCommentThreads.workflowId, input.workflowId),
        input.after === undefined
          ? undefined
          : lt(workflowCommentThreads.id, input.after),
        input.status === 'all'
          ? undefined
          : eq(workflowCommentThreads.status, input.status),
        threadScope(input),
      ),
    )
    .orderBy(desc(workflowCommentThreads.id))
    .limit(input.limit + 1)
    .catch(rethrowQueryFailure);
  return found;
}

export async function readThreadRow(
  client: PoolClient,
  input: ReadThreadInput,
) {
  const db = drizzle(client);
  const [thread] = await db
    .select(threadProjection)
    .from(workflowCommentThreads)
    .where(
      and(
        eq(workflowCommentThreads.workspaceId, input.workspaceId),
        eq(workflowCommentThreads.workflowId, input.workflowId),
        eq(workflowCommentThreads.id, input.threadId),
      ),
    )
    .catch(rethrowQueryFailure);
  return thread;
}

/** Whether the anchor comment belongs to the thread. */
export async function commentInThread(
  client: PoolClient,
  input: ReadThreadInput & Readonly<{ anchor: string }>,
) {
  const db = drizzle(client);
  const anchor = await db
    .select({ id: workflowComments.id })
    .from(workflowComments)
    .where(
      and(
        eq(workflowComments.workspaceId, input.workspaceId),
        eq(workflowComments.threadId, input.threadId),
        eq(workflowComments.id, input.anchor),
      ),
    )
    .catch(rethrowQueryFailure);
  return anchor.length === 1;
}

/** One page of the thread's comments, newest first, one past the limit. */
export async function readThreadCommentRows(
  client: PoolClient,
  input: ReadThreadInput,
) {
  const db = drizzle(client);
  const found = await db
    .select(commentProjection)
    .from(workflowComments)
    .leftJoin(users, eq(users.id, workflowComments.authorId))
    .where(
      and(
        eq(workflowComments.workspaceId, input.workspaceId),
        eq(workflowComments.threadId, input.threadId),
        input.before === undefined
          ? undefined
          : lt(workflowComments.id, input.before),
        input.anchor === undefined
          ? undefined
          : lte(workflowComments.id, input.anchor),
      ),
    )
    .orderBy(desc(workflowComments.id))
    .limit(input.limit + 1)
    .catch(rethrowQueryFailure);
  return found;
}
