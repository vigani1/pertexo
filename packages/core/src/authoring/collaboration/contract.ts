import type {
  WorkflowCommentBody,
  WorkflowCommentCreate,
  WorkflowCommentEdit,
  WorkflowCommentDelete,
  WorkflowCommentStatus,
  WorkflowCommentListQuery,
  WorkflowCommentDetailQuery,
  WorkflowPresenceHeartbeat,
  WorkspacePeopleQuery,
} from '@pertexo/contracts';

export type CollaborationScope = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  signal?: AbortSignal;
}>;

export type CollaborationCommand = CollaborationScope &
  Readonly<{ idempotencyKey: string; requestId?: string; traceId?: string }>;

export type ThreadScope = CollaborationScope & Readonly<{ threadId: string }>;

export type ThreadCommand = CollaborationCommand &
  Readonly<{ threadId: string }>;

export type ListCommentsInput = CollaborationScope & WorkflowCommentListQuery;
export type ReadThreadInput = ThreadScope & WorkflowCommentDetailQuery;
export type ReadPeopleInput = CollaborationScope & WorkspacePeopleQuery;
export type CreateCommentInput = CollaborationCommand & WorkflowCommentCreate;
export type ReplyInput = ThreadCommand & WorkflowCommentBody;
export type EditCommentInput = ThreadCommand &
  WorkflowCommentEdit & { commentId: string };
export type RemoveCommentInput = ThreadCommand &
  WorkflowCommentDelete & { commentId: string };
export type SetThreadStatusInput = ThreadCommand & WorkflowCommentStatus;
export type PresenceInput = CollaborationScope & { tabId: string };
export type HeartbeatInput = CollaborationScope &
  WorkflowPresenceHeartbeat & { tabId: string };
