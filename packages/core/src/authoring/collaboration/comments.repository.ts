import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflowCommentThreads,
  workflowComments,
  workflowDrafts,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import { generatePersistedId } from '@pertexo/database/platform';
import type {
  CollaborationCommand,
  CollaborationScope,
  SetThreadStatusInput,
} from './workflow-collaboration.types.js';

type CommentScope = CollaborationScope &
  Readonly<{ threadId: string; commentId: string }>;

const threadOf = (input: CollaborationScope & Readonly<{ threadId: string }>) =>
  and(
    eq(workflowCommentThreads.workspaceId, input.workspaceId),
    eq(workflowCommentThreads.id, input.threadId),
  );
const commentOf = (input: CommentScope) =>
  and(
    eq(workflowComments.workspaceId, input.workspaceId),
    eq(workflowComments.threadId, input.threadId),
    eq(workflowComments.id, input.commentId),
  );

/** A new comment; returns its id. */
export async function insertComment(
  client: PoolClient,
  input: CollaborationCommand & { threadId: string; body: string },
) {
  const commentId = generatePersistedId();
  await drizzle(client)
    .insert(workflowComments)
    .values({
      workspaceId: input.workspaceId,
      id: commentId,
      threadId: input.threadId,
      authorId: input.actorId,
      body: input.body,
    })
    .catch(rethrowQueryFailure);
  return commentId;
}

/** The comment's author and revision, locked for the change. */
export async function lockComment(client: PoolClient, input: CommentScope) {
  const [comment] = await drizzle(client)
    .select({
      authorId: workflowComments.authorId,
      revision: workflowComments.revision,
    })
    .from(workflowComments)
    .where(commentOf(input))
    .for('update')
    .catch(rethrowQueryFailure);
  return comment;
}

/** The draft graph a step comment is checked against, shared while it is written. */
export async function shareDraftGraph(
  client: PoolClient,
  input: CollaborationScope,
) {
  const [draft] = await drizzle(client)
    .select({ graphJson: workflowDrafts.graphJson })
    .from(workflowDrafts)
    .where(
      and(
        eq(workflowDrafts.workspaceId, input.workspaceId),
        eq(workflowDrafts.workflowId, input.workflowId),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  return draft?.graphJson;
}

export async function insertCommentThread(
  client: PoolClient,
  input: CollaborationScope &
    Readonly<{
      threadId: string;
      stepId: string | null;
      stepLabel: string | null;
    }>,
) {
  await drizzle(client)
    .insert(workflowCommentThreads)
    .values({
      workspaceId: input.workspaceId,
      id: input.threadId,
      workflowId: input.workflowId,
      stepId: input.stepId,
      stepLabel: input.stepLabel,
      createdBy: input.actorId,
      commentCount: 1,
    })
    .catch(rethrowQueryFailure);
}

/** Moves the thread's revision on, and its comment count by `comments`. */
export async function advanceThread(
  client: PoolClient,
  input: CollaborationScope & Readonly<{ threadId: string }>,
  comments: -1 | 0 | 1,
) {
  await drizzle(client)
    .update(workflowCommentThreads)
    .set({
      revision: sql`${workflowCommentThreads.revision}+1`,
      updatedAt: sql`clock_timestamp()`,
      ...(comments === 0
        ? {}
        : {
            commentCount: sql`${workflowCommentThreads.commentCount}${sql.raw(comments === 1 ? '+' : '-')}1`,
          }),
    })
    .where(threadOf(input))
    .catch(rethrowQueryFailure);
}

export async function updateCommentBody(
  client: PoolClient,
  input: CommentScope & Readonly<{ body: string; expectedRevision: number }>,
) {
  await drizzle(client)
    .update(workflowComments)
    .set({
      body: input.body,
      revision: sql`${workflowComments.revision}+1`,
      editedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        commentOf(input),
        eq(workflowComments.revision, input.expectedRevision),
      ),
    )
    .catch(rethrowQueryFailure);
}

export async function deleteComment(
  client: PoolClient,
  input: CommentScope & Readonly<{ expectedRevision: number }>,
) {
  await drizzle(client)
    .delete(workflowComments)
    .where(
      and(
        commentOf(input),
        eq(workflowComments.revision, input.expectedRevision),
      ),
    )
    .catch(rethrowQueryFailure);
}

export async function deleteCommentThread(
  client: PoolClient,
  input: CollaborationScope & Readonly<{ threadId: string }>,
) {
  await drizzle(client)
    .delete(workflowCommentThreads)
    .where(threadOf(input))
    .catch(rethrowQueryFailure);
}

export async function setCommentThreadStatus(
  client: PoolClient,
  input: CollaborationScope &
    Readonly<{
      threadId: string;
      status: SetThreadStatusInput['status'];
      expectedRevision: number;
    }>,
) {
  await drizzle(client)
    .update(workflowCommentThreads)
    .set({
      revision: sql`${workflowCommentThreads.revision}+1`,
      updatedAt: sql`clock_timestamp()`,
      status: input.status,
    })
    .where(
      and(
        threadOf(input),
        eq(workflowCommentThreads.revision, input.expectedRevision),
      ),
    )
    .catch(rethrowQueryFailure);
}
