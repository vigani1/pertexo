import {
  COLLABORATION_LIMITS,
  workflowCommentListSchema,
  workflowCommentDetailSchema,
  workflowCommentCommandResultSchema,
  workflowPresenceSchema,
  workflowPresenceHeartbeatResultSchema,
  workspacePeoplePageSchema,
  type WorkflowPresenceHeartbeat,
  type WorkflowCommentCreate,
  type WorkflowCommentBody,
  type WorkflowCommentEdit,
  type WorkflowCommentDelete,
  type WorkflowCommentStatus,
  type WorkflowCommentListQuery,
} from '@pertexo/contracts';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
export type CollaborationScope = WorkspaceApiScope & { workflowId: string };
function path(scope: CollaborationScope, suffix: string): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/workflows/${encodeURIComponent(scope.workflowId)}/${suffix}`;
}
export function readThreads(
  scope: CollaborationScope,
  filter: Pick<WorkflowCommentListQuery, 'status' | 'scope' | 'stepId'>,
  after: string | null,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({
    status: filter.status,
    scope: filter.scope,
    limit: String(COLLABORATION_LIMITS.page),
  });
  if (filter.stepId !== undefined) query.set('stepId', filter.stepId);
  if (after !== null) query.set('after', after);
  return scope.apiClient.request({
    path: path(scope, 'comments?' + query.toString()),
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowCommentListSchema.parse(value),
    },
  });
}
export function readDiscussion({
  scope,
  threadId,
  before,
  anchor,
  signal,
}: Readonly<{
  scope: CollaborationScope;
  threadId: string;
  before: string | null;
  anchor: string | undefined;
  signal: AbortSignal;
}>) {
  const query = new URLSearchParams({
    limit: String(COLLABORATION_LIMITS.page),
  });
  if (before !== null) query.set('before', before);
  else if (anchor !== undefined) query.set('anchor', anchor);
  return scope.apiClient.request({
    path: path(scope, 'comments/' + threadId + '?' + query.toString()),
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowCommentDetailSchema.parse(value),
    },
  });
}
export function readPeople(
  scope: CollaborationScope,
  q: string,
  after: string | null,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({ q });
  if (after !== null) query.set('after', after);
  return scope.apiClient.request({
    path: path(scope, 'comments/people?' + query.toString()),
    signal,
    response: {
      kind: 'json',
      decode: (value) => workspacePeoplePageSchema.parse(value),
    },
  });
}
export type DiscussionCommand =
  | { kind: 'create'; body: WorkflowCommentCreate }
  | { kind: 'reply'; threadId: string; body: WorkflowCommentBody }
  | {
      kind: 'edit';
      threadId: string;
      commentId: string;
      body: WorkflowCommentEdit;
    }
  | {
      kind: 'remove';
      threadId: string;
      commentId: string;
      body: WorkflowCommentDelete;
    }
  | { kind: 'status'; threadId: string; body: WorkflowCommentStatus };
export function sendDiscussion(
  scope: CollaborationScope,
  command: DiscussionCommand,
  key: string,
) {
  const suffix = discussionSuffix(command);
  return scope.apiClient.request({
    path: path(scope, 'comments' + suffix),
    method: DISCUSSION_METHODS[command.kind],
    body: command.body,
    headers: { 'Idempotency-Key': key },
    response: {
      kind: 'json',
      decode: (value) => workflowCommentCommandResultSchema.parse(value),
    },
  });
}
export function readPresence(
  scope: CollaborationScope,
  tabId: string,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: path(scope, 'presence?' + new URLSearchParams({ tabId }).toString()),
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowPresenceSchema.parse(value),
    },
  });
}
export function heartbeatPresence(
  scope: CollaborationScope,
  tabId: string,
  body: WorkflowPresenceHeartbeat,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: path(scope, 'presence/' + tabId),
    method: 'PUT',
    body,
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowPresenceHeartbeatResultSchema.parse(value),
    },
  });
}

/** Ends this tab's lease as the page goes, so it can't read as another tab. */
export function leavePresence(scope: CollaborationScope, tabId: string) {
  return scope.apiClient.request({
    path: path(scope, 'presence/' + tabId),
    method: 'DELETE',
    keepalive: true,
    response: { kind: 'empty' },
  });
}

const DISCUSSION_METHODS = {
  create: 'POST',
  reply: 'POST',
  remove: 'DELETE',
  edit: 'PUT',
  status: 'PUT',
} as const;

function discussionSuffix(command: DiscussionCommand): string {
  if (command.kind === 'create') return '';
  if (command.kind === 'reply') return '/' + command.threadId + '/replies';
  if (command.kind === 'status') return '/' + command.threadId + '/status';
  return '/' + command.threadId + '/comments/' + command.commentId;
}
