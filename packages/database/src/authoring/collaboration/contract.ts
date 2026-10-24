import type {
  WorkflowCommentBody,
  WorkflowCommentCreate,
  WorkflowCommentEdit,
  WorkflowCommentDelete,
  WorkflowCommentStatus,
  WorkflowCommentListQuery,
  WorkflowCommentDetailQuery,
  WorkflowCommentList,
  WorkflowCommentDetail,
  WorkflowCommentCommandResult,
  WorkflowPresenceHeartbeat,
  WorkflowPresence,
  WorkspacePeopleQuery,
  WorkspacePeoplePage,
} from '@pertexo/contracts';
import type { WorkflowAuthoringWriteContext } from '../workflows/context.js';

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

export interface WorkflowCollaborationStore {
  list(
    input: CollaborationScope & WorkflowCommentListQuery,
  ): Promise<WorkflowCommentList>;
  read(
    input: ThreadScope & WorkflowCommentDetailQuery,
  ): Promise<WorkflowCommentDetail>;
  people(
    input: CollaborationScope & WorkspacePeopleQuery,
  ): Promise<WorkspacePeoplePage>;
  create(
    input: CollaborationCommand & WorkflowCommentCreate,
  ): Promise<WorkflowCommentCommandResult>;
  reply(
    input: ThreadCommand & WorkflowCommentBody,
  ): Promise<WorkflowCommentCommandResult>;
  edit(
    input: ThreadCommand & WorkflowCommentEdit & { commentId: string },
  ): Promise<WorkflowCommentCommandResult>;
  remove(
    input: ThreadCommand & WorkflowCommentDelete & { commentId: string },
  ): Promise<WorkflowCommentCommandResult>;
  setStatus(
    input: ThreadCommand & WorkflowCommentStatus,
  ): Promise<WorkflowCommentCommandResult>;
  presence(
    input: CollaborationScope & { tabId: string },
  ): Promise<WorkflowPresence>;
  heartbeat(
    input: CollaborationScope & WorkflowPresenceHeartbeat & { tabId: string },
  ): Promise<{ accepted: boolean }>;
  leave(input: CollaborationScope & { tabId: string }): Promise<void>;
}

export type CollaborationContext = Pick<
  WorkflowAuthoringWriteContext,
  'transact'
>;
