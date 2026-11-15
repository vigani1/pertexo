import { decodeStoredValue } from '../../shared/stored-values.js';
import type { PoolClient } from 'pg';
import {
  workflowNodes,
  parseWorkflowGraphDraft,
} from '@pertexo/workflow-model';
import { generatePersistedId } from '@pertexo/database/platform';
import { WorkflowNotFoundError } from '../workflows/workflow-authoring.errors.js';
import {
  requireThread,
  WorkflowCollaborationError,
} from './workflow-collaboration.errors.js';
import type { WorkflowCommentCommandResult } from '@pertexo/contracts';
import type { CollaborationScope } from './workflow-collaboration.types.js';
import type { EnterCollaboration } from './authority.repository.js';
import type {
  CollaborationCommand,
  CreateCommentInput,
  EditCommentInput,
  RemoveCommentInput,
  ReplyInput,
  SetThreadStatusInput,
} from './workflow-collaboration.types.js';
import { lockCommentThread } from './comment-threads.repository.js';
import { runCommentCommand } from './run-comment-command.js';
import {
  advanceThread,
  deleteComment,
  deleteCommentThread,
  insertComment,
  insertCommentThread,
  lockComment,
  setCommentThreadStatus,
  shareDraftGraph,
  updateCommentBody,
} from './comments.repository.js';
import { stepSnapshotLabel } from './comment-step-label.js';
import {
  replaceCommentMentions,
  shareMentionedMembers,
} from './mentions.repository.js';
import { mentionsReachable } from './mention-access.js';

async function requireOwnComment(
  client: PoolClient,
  input: CollaborationCommand & {
    threadId: string;
    commentId: string;
    expectedRevision: number;
  },
) {
  const comment = await lockComment(client, input);
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
export function collaborationCommands(enter: EnterCollaboration) {
  return {
    create: (input: CreateCommentInput) => createCommentThread(enter, input),
    reply: (input: ReplyInput) => replyToCommentThread(enter, input),
    edit: (input: EditCommentInput) => editComment(enter, input),
    remove: (input: RemoveCommentInput) => removeComment(enter, input),
    setStatus: (input: SetThreadStatusInput) =>
      changeCommentThreadStatus(enter, input),
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
        const graphJson = await shareDraftGraph(client, input);
        if (graphJson === undefined)
          throw new WorkflowNotFoundError('Draft is not visible');
        const matches = [
          ...workflowNodes(
            decodeStoredValue(() => parseWorkflowGraphDraft(graphJson)),
          ),
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
      await insertCommentThread(client, {
        ...input,
        threadId,
        stepId: input.stepId,
        stepLabel,
      });
      const commentId = await commentWithMentions(client, {
        ...input,
        threadId,
      });
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
      const thread = requireThread(await lockCommentThread(client, input));
      if (thread.status !== 'open')
        throw new WorkflowCollaborationError(
          'conflict',
          'Reopen this discussion before replying. Your text is kept.',
        );
      const commentId = await commentWithMentions(client, input);
      await advanceThread(client, input, 1);
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
      requireThread(await lockCommentThread(client, input));
      await requireOwnComment(client, input);
      await updateCommentBody(client, input);
      await syncCommentMentions(
        client,
        input,
        input.commentId,
        input.mentionUserIds,
      );
      await advanceThread(client, input, 0);
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
      const thread = requireThread(await lockCommentThread(client, input));
      await requireOwnComment(client, input);
      await deleteComment(client, input);
      const empty = thread.commentCount === 1;
      if (empty) await deleteCommentThread(client, input);
      else await advanceThread(client, input, -1);
      return commandResult(input.threadId, input.commentId, {
        revision: input.expectedRevision + 1,
        deleted: true,
        threadDeleted: empty,
      });
    },
  });
}

function changeCommentThreadStatus(
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
      const thread = requireThread(await lockCommentThread(client, input));
      if (thread.revision !== input.expectedRevision)
        throw new WorkflowCollaborationError(
          'conflict',
          'This discussion changed. Review its latest state before resolving or reopening it.',
        );
      await setCommentThreadStatus(client, input);
      return commandResult(input.threadId, null, {
        revision: input.expectedRevision + 1,
      });
    },
    status: input.status,
  });
}

async function commentWithMentions(
  client: PoolClient,
  input: Parameters<typeof insertComment>[1] & { mentionUserIds: string[] },
) {
  const commentId = await insertComment(client, input);
  await syncCommentMentions(client, input, commentId, input.mentionUserIds);
  return commentId;
}

async function syncCommentMentions(
  client: PoolClient,
  input: CollaborationScope,
  commentId: string,
  userIds: readonly string[],
) {
  if (
    userIds.length > 0 &&
    !mentionsReachable(
      await shareMentionedMembers(client, input, userIds),
      userIds,
    )
  )
    throw new WorkflowCollaborationError(
      'conflict',
      'A mentioned person no longer has access. Remove them and review the comment before trying again.',
    );
  await replaceCommentMentions(client, input, commentId, userIds);
}
