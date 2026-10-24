import type { PoolClient } from 'pg';
import {
  workflowNodes,
  parseWorkflowGraphDraft,
} from '@pertexo/workflow-model';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import {
  WorkflowCollaborationError,
  type CollaborationCommand,
  type CollaborationContext,
  type WorkflowCollaborationStore,
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
  await client.query(
    'insert into app.workflow_comments(workspace_id,id,thread_id,author_id,body) values($1,$2,$3,$4,$5)',
    [input.workspaceId, commentId, input.threadId, input.actorId, input.body],
  );
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
    await client.query<{ author_id: string | null; revision: number }>(
      'select author_id,revision from app.workflow_comments where workspace_id=$1 and thread_id=$2 and id=$3 for update',
      [input.workspaceId, input.threadId, input.commentId],
    )
  ).rows[0];
  if (comment === undefined)
    throw new WorkflowNotFoundError('Comment is not visible');
  if (comment.author_id !== input.actorId)
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
export function collaborationCommands(
  context: CollaborationContext,
): Pick<
  WorkflowCollaborationStore,
  'create' | 'reply' | 'edit' | 'remove' | 'setStatus'
> {
  return {
    create: (input) => createCommentThread(context, input),
    reply: (input) => replyToCommentThread(context, input),
    edit: (input) => editComment(context, input),
    remove: (input) => removeComment(context, input),
    setStatus: (input) => setCommentThreadStatus(context, input),
  };
}

function createCommentThread(
  context: CollaborationContext,
  input: Parameters<WorkflowCollaborationStore['create']>[0],
): ReturnType<WorkflowCollaborationStore['create']> {
  return runCommentCommand(context, input, {
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
          await client.query<{ graph_json: unknown }>(
            'select graph_json from app.workflow_drafts where workspace_id=$1 and workflow_id=$2 for share',
            [input.workspaceId, input.workflowId],
          )
        ).rows[0];
        if (draft === undefined)
          throw new WorkflowNotFoundError('Draft is not visible');
        const matches = [
          ...workflowNodes(parseWorkflowGraphDraft(draft.graph_json)),
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
      await client.query(
        'insert into app.workflow_comment_threads(workspace_id,id,workflow_id,step_id,step_label,created_by,comment_count) values($1,$2,$3,$4,$5,$6,1)',
        [
          input.workspaceId,
          threadId,
          input.workflowId,
          input.stepId,
          stepLabel,
          input.actorId,
        ],
      );
      const commentId = await insertComment(client, { ...input, threadId });
      return commandResult(threadId, commentId, { revision: 1 });
    },
  });
}

function replyToCommentThread(
  context: CollaborationContext,
  input: Parameters<WorkflowCollaborationStore['reply']>[0],
): ReturnType<WorkflowCollaborationStore['reply']> {
  return runCommentCommand(context, input, {
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
      await client.query(
        'update app.workflow_comment_threads set comment_count=comment_count+1,revision=revision+1,updated_at=clock_timestamp() where workspace_id=$1 and id=$2',
        [input.workspaceId, input.threadId],
      );
      return commandResult(input.threadId, commentId, { revision: 1 });
    },
  });
}

function editComment(
  context: CollaborationContext,
  input: Parameters<WorkflowCollaborationStore['edit']>[0],
): ReturnType<WorkflowCollaborationStore['edit']> {
  return runCommentCommand(context, input, {
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
      await client.query(
        'update app.workflow_comments set body=$4,revision=revision+1,edited_at=clock_timestamp() where workspace_id=$1 and thread_id=$2 and id=$3 and revision=$5',
        [
          input.workspaceId,
          input.threadId,
          input.commentId,
          input.body,
          input.expectedRevision,
        ],
      );
      await syncCommentMentions(
        client,
        input,
        input.commentId,
        input.mentionUserIds,
      );
      await client.query(
        'update app.workflow_comment_threads set revision=revision+1,updated_at=clock_timestamp() where workspace_id=$1 and id=$2',
        [input.workspaceId, input.threadId],
      );
      return commandResult(input.threadId, input.commentId, {
        revision: input.expectedRevision + 1,
      });
    },
  });
}

function removeComment(
  context: CollaborationContext,
  input: Parameters<WorkflowCollaborationStore['remove']>[0],
): ReturnType<WorkflowCollaborationStore['remove']> {
  return runCommentCommand(context, input, {
    action: 'workflow.comment.deleted',
    request: {
      threadId: input.threadId,
      commentId: input.commentId,
      expectedRevision: input.expectedRevision,
    },
    write: async (client) => {
      const thread = await lockCommentThread(client, input);
      await requireOwnComment(client, input);
      await client.query(
        'delete from app.workflow_comments where workspace_id=$1 and thread_id=$2 and id=$3 and revision=$4',
        [
          input.workspaceId,
          input.threadId,
          input.commentId,
          input.expectedRevision,
        ],
      );
      const empty = thread.comment_count === 1;
      if (empty)
        await client.query(
          'delete from app.workflow_comment_threads where workspace_id=$1 and id=$2',
          [input.workspaceId, input.threadId],
        );
      else
        await client.query(
          'update app.workflow_comment_threads set comment_count=comment_count-1,revision=revision+1,updated_at=clock_timestamp() where workspace_id=$1 and id=$2',
          [input.workspaceId, input.threadId],
        );
      return commandResult(input.threadId, input.commentId, {
        revision: input.expectedRevision + 1,
        deleted: true,
        threadDeleted: empty,
      });
    },
  });
}

function setCommentThreadStatus(
  context: CollaborationContext,
  input: Parameters<WorkflowCollaborationStore['setStatus']>[0],
): ReturnType<WorkflowCollaborationStore['setStatus']> {
  return runCommentCommand(context, input, {
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
      await client.query(
        'update app.workflow_comment_threads set status=$3,revision=revision+1,updated_at=clock_timestamp() where workspace_id=$1 and id=$2 and revision=$4',
        [
          input.workspaceId,
          input.threadId,
          input.status,
          input.expectedRevision,
        ],
      );
      return commandResult(input.threadId, null, {
        revision: input.expectedRevision + 1,
      });
    },
    status: input.status,
  });
}
