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
import type {
  WorkflowComment,
  WorkflowCommentDetail,
  WorkflowCommentList,
  WorkspacePeoplePage,
} from '@pertexo/contracts';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import { readWorkspacePeople } from '../../tenant-access/members/discovery.queries.js';
import { projectCommentThread } from './records.queries.js';
import type { EnterCollaboration } from './authority.queries.js';
import type {
  ListCommentsInput,
  ReadPeopleInput,
  ReadThreadInput,
} from './contract.js';
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
async function projectComments(
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
export function collaborationReads(enter: EnterCollaboration) {
  return {
    list: (input: ListCommentsInput): Promise<WorkflowCommentList> =>
      enter(input, { browsing: true }, async (client) => {
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
        const rows = found.slice(0, input.limit);
        return {
          items: rows.map(projectCommentThread),
          nextCursor:
            found.length > input.limit ? (rows.at(-1)?.id ?? null) : null,
        };
      }),
    read: (input: ReadThreadInput): Promise<WorkflowCommentDetail> =>
      enter(input, { browsing: true }, async (client) => {
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
        if (thread === undefined)
          throw new WorkflowNotFoundError('Discussion is not visible');
        if (input.anchor !== undefined) {
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
          if (anchor.length !== 1)
            throw new WorkflowNotFoundError('Comment is not visible');
        }
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
        const rows = found.slice(0, input.limit);
        return {
          thread: projectCommentThread(thread),
          comments: await projectComments(client, input.workspaceId, rows),
          nextCursor:
            found.length > input.limit ? (rows.at(-1)?.id ?? null) : null,
        };
      }),
    people: (input: ReadPeopleInput): Promise<WorkspacePeoplePage> =>
      enter(input, { browsing: true }, async (client) => {
        return readWorkspacePeople(client, input);
      }),
  };
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
