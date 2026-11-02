import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflowCommentThreads,
  workflowComments,
  workflowDrafts,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import {
  workflowNodes,
  parseWorkflowGraphDraft,
} from '@pertexo/workflow-model';
import { generatePersistedId } from '@pertexo/database/platform';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import { WorkflowCollaborationError } from './errors.js';
import type { WorkflowCommentCommandResult } from '@pertexo/contracts';
import type { EnterCollaboration } from './authority.queries.js';
import type {
  CollaborationCommand,
  CreateCommentInput,
  EditCommentInput,
  RemoveCommentInput,
  ReplyInput,
  SetThreadStatusInput,
} from './contract.js';
import { lockCommentThread } from './records.queries.js';
import { syncCommentMentions } from './mentions.repository.js';
import { runCommentCommand } from './receipt.js';
async function insertComment(
  client: PoolClient,
  input: CollaborationCommand & {
    threadId: string;
    body: string;
    mentionUserIds: string[];
  },
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
  await syncCommentMentions(client, input, commentId, input.mentionUserIds);
  return commentId;
}
async function requireOwnComment(
  client: PoolClient,
  input: CollaborationCommand & {
    threadId: string;
    commentId: string;
    expectedRevision: number;
  },
) {
  const comment = (
    await drizzle(client)
      .select({
        authorId: workflowComments.authorId,
        revision: workflowComments.revision,
      })
      .from(workflowComments)
      .where(
        and(
          eq(workflowComments.workspaceId, input.workspaceId),
          eq(workflowComments.threadId, input.threadId),
          eq(workflowComments.id, input.commentId),
        ),
      )
      .for('update')
      .catch(rethrowQueryFailure)
  )[0];
  if (comment === undefined)
    throw new WorkflowNotFoundError('Comment is not visible');
  if (comment.authorId !== input.actorId)
    throw new WorkflowCollaborationError(
      'forbidden',
      'Only the author can change this comment.',
    );
  if (comment.revision !== input.expectedRevision)
    throw new WorkflowCollaborationError(
      'conflict',
      'This comment changed. Your text is kept; review the latest comment before trying again.',
    );
}
const commandResult = (
  threadId: string,
  commentId: string | null,
  {
    revision,
    deleted = false,
    threadDeleted = false,
  }: Readonly<{
    revision: number;
    deleted?: boolean | undefined;
    threadDeleted?: boolean | undefined;
  }>,
) => ({
  threadId,
  commentId,
  revision,
  deleted,
  threadDeleted,
  replayed: false,
});
/** Former-step metadata stays bounded without splitting a displayed grapheme. */
function stepSnapshotLabel(value: string): string {
  if (value.length <= 256) return value;
  let label = '';
  for (const { segment } of new Intl.Segmenter('und', {
    granularity: 'grapheme',
  }).segment(value)) {
    if (label.length + segment.length > 255) break;
    label += segment;
  }
  return label + '…';
}
export function collaborationCommands(enter: EnterCollaboration) {
  return {
    create: (input: CreateCommentInput) => createCommentThread(enter, input),
    reply: (input: ReplyInput) => replyToCommentThread(enter, input),
    edit: (input: EditCommentInput) => editComment(enter, input),
    remove: (input: RemoveCommentInput) => removeComment(enter, input),
    setStatus: (input: SetThreadStatusInput) =>
      setCommentThreadStatus(enter, input),
  };
}

function createCommentThread(
  enter: EnterCollaboration,
  input: CreateCommentInput,
): Promise<WorkflowCommentCommandResult> {
  return runCommentCommand(enter, input, {
    action: 'workflow.comment.created',
    request: {
      body: input.body,
      mentionUserIds: input.mentionUserIds,
      stepId: input.stepId,
    },
    write: async (client) => {
      let stepLabel: string | null = null;
      if (input.stepId !== null) {
        const draft = (
          await drizzle(client)
            .select({ graphJson: workflowDrafts.graphJson })
            .from(workflowDrafts)
            .where(
              and(
                eq(workflowDrafts.workspaceId, input.workspaceId),
                eq(workflowDrafts.workflowId, input.workflowId),
              ),
            )
            .for('share')
            .catch(rethrowQueryFailure)
        )[0];
        if (draft === undefined)
          throw new WorkflowNotFoundError('Draft is not visible');
        const matches = [
          ...workflowNodes(parseWorkflowGraphDraft(draft.graphJson)),
        ].filter((node) => node.id === input.stepId);
        if (matches.length !== 1)
          throw new WorkflowCollaborationError(
            'conflict',
            'This step is missing or its identity is ambiguous. Save the step or start a workflow discussion instead.',
          );
        const step = matches[0];
        if (step === undefined) throw new Error('Matched step missing');
        stepLabel = stepSnapshotLabel(step.label ?? step.definition.key);
      }
      const threadId = generatePersistedId();
      await drizzle(client)
        .insert(workflowCommentThreads)
        .values({
          workspaceId: input.workspaceId,
          id: threadId,
          workflowId: input.workflowId,
          stepId: input.stepId,
          stepLabel,
          createdBy: input.actorId,
          commentCount: 1,
        })
        .catch(rethrowQueryFailure);
      const commentId = await insertComment(client, { ...input, threadId });
      return commandResult(threadId, commentId, { revision: 1 });
    },
  });
}

function replyToCommentThread(
  enter: EnterCollaboration,
  input: ReplyInput,
): Promise<WorkflowCommentCommandResult> {
  return runCommentCommand(enter, input, {
    action: 'workflow.comment.replied',
    request: {
      threadId: input.threadId,
      body: input.body,
      mentionUserIds: input.mentionUserIds,
    },
    write: async (client) => {
      const thread = await lockCommentThread(client, input);
      if (thread.status !== 'open')
        throw new WorkflowCollaborationError(
          'conflict',
          'Reopen this discussion before replying. Your text is kept.',
        );
      const commentId = await insertComment(client, input);
      await drizzle(client)
        .update(workflowCommentThreads)
        .set({
          revision: sql`${workflowCommentThreads.revision}+1`,
          updatedAt: sql`clock_timestamp()`,
          commentCount: sql`${workflowCommentThreads.commentCount}+1`,
        })
        .where(
          and(
            eq(workflowCommentThreads.workspaceId, input.workspaceId),
            eq(workflowCommentThreads.id, input.threadId),
          ),
        )
        .catch(rethrowQueryFailure);
      return commandResult(input.threadId, commentId, { revision: 1 });
    },
  });
}

function editComment(
  enter: EnterCollaboration,
  input: EditCommentInput,
): Promise<WorkflowCommentCommandResult> {
  return runCommentCommand(enter, input, {
    action: 'workflow.comment.edited',
    request: {
      threadId: input.threadId,
      commentId: input.commentId,
      body: input.body,
      mentionUserIds: input.mentionUserIds,
      expectedRevision: input.expectedRevision,
    },
    write: async (client) => {
      await lockCommentThread(client, input);
      await requireOwnComment(client, input);
      await drizzle(client)
        .update(workflowComments)
        .set({
          body: input.body,
          revision: sql`${workflowComments.revision}+1`,
          editedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(workflowComments.workspaceId, input.workspaceId),
            eq(workflowComments.threadId, input.threadId),
            eq(workflowComments.id, input.commentId),
            eq(workflowComments.revision, input.expectedRevision),
          ),
        )
        .catch(rethrowQueryFailure);
      await syncCommentMentions(
        client,
        input,
        input.commentId,
        input.mentionUserIds,
      );
      await drizzle(client)
        .update(workflowCommentThreads)
        .set({
          revision: sql`${workflowCommentThreads.revision}+1`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(workflowCommentThreads.workspaceId, input.workspaceId),
            eq(workflowCommentThreads.id, input.threadId),
          ),
        )
        .catch(rethrowQueryFailure);
      return commandResult(input.threadId, input.commentId, {
        revision: input.expectedRevision + 1,
      });
    },
  });
}

function removeComment(
  enter: EnterCollaboration,
  input: RemoveCommentInput,
): Promise<WorkflowCommentCommandResult> {
  return runCommentCommand(enter, input, {
    action: 'workflow.comment.deleted',
    request: {
      threadId: input.threadId,
      commentId: input.commentId,
      expectedRevision: input.expectedRevision,
    },
    write: async (client) => {
      const thread = await lockCommentThread(client, input);
      await requireOwnComment(client, input);
      await drizzle(client)
        .delete(workflowComments)
        .where(
          and(
            eq(workflowComments.workspaceId, input.workspaceId),
            eq(workflowComments.threadId, input.threadId),
            eq(workflowComments.id, input.commentId),
            eq(workflowComments.revision, input.expectedRevision),
          ),
        )
        .catch(rethrowQueryFailure);
      const empty = thread.commentCount === 1;
      if (empty)
        await drizzle(client)
          .delete(workflowCommentThreads)
          .where(
            and(
              eq(workflowCommentThreads.workspaceId, input.workspaceId),
              eq(workflowCommentThreads.id, input.threadId),
            ),
          )
          .catch(rethrowQueryFailure);
      else
        await drizzle(client)
          .update(workflowCommentThreads)
          .set({
            revision: sql`${workflowCommentThreads.revision}+1`,
            updatedAt: sql`clock_timestamp()`,
            commentCount: sql`${workflowCommentThreads.commentCount}-1`,
          })
          .where(
            and(
              eq(workflowCommentThreads.workspaceId, input.workspaceId),
              eq(workflowCommentThreads.id, input.threadId),
            ),
          )
          .catch(rethrowQueryFailure);
      return commandResult(input.threadId, input.commentId, {
        revision: input.expectedRevision + 1,
        deleted: true,
        threadDeleted: empty,
      });
    },
  });
}

function setCommentThreadStatus(
  enter: EnterCollaboration,
  input: SetThreadStatusInput,
): Promise<WorkflowCommentCommandResult> {
  return runCommentCommand(enter, input, {
    action: 'workflow.comment.thread.changed',
    request: {
      threadId: input.threadId,
      status: input.status,
      expectedRevision: input.expectedRevision,
    },
    write: async (client) => {
      const thread = await lockCommentThread(client, input);
      if (thread.revision !== input.expectedRevision)
        throw new WorkflowCollaborationError(
          'conflict',
          'This discussion changed. Review its latest state before resolving or reopening it.',
        );
      await drizzle(client)
        .update(workflowCommentThreads)
        .set({
          revision: sql`${workflowCommentThreads.revision}+1`,
          updatedAt: sql`clock_timestamp()`,
          status: input.status,
        })
        .where(
          and(
            and(
              eq(workflowCommentThreads.workspaceId, input.workspaceId),
              eq(workflowCommentThreads.id, input.threadId),
            ),
            eq(workflowCommentThreads.revision, input.expectedRevision),
          ),
        )
        .catch(rethrowQueryFailure);
      return commandResult(input.threadId, null, {
        revision: input.expectedRevision + 1,
      });
    },
    status: input.status,
  });
}
