import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import {
  COLLABORATION_LIMITS,
  type WorkflowCommentListQuery,
} from '@pertexo/contracts';
import {
  readThreads,
  readDiscussion,
  readPeople,
  readPresence,
  type CollaborationScope,
} from './collaboration.api';
export const collaborationKeys = {
  scope: (scope: CollaborationScope) =>
    [
      'identity',
      scope.userId,
      'workspace',
      scope.workspaceId,
      'workflow',
      scope.workflowId,
      'collaboration',
    ] as const,
};
export function threadsQuery(
  scope: CollaborationScope,
  filter: Pick<WorkflowCommentListQuery, 'status' | 'scope' | 'stepId'>,
) {
  return infiniteQueryOptions({
    queryKey: [...collaborationKeys.scope(scope), 'threads', filter],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      readThreads(scope, filter, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: COLLABORATION_LIMITS.pollMs,
    gcTime: 0,
    retry: false,
  });
}
export function discussionQuery(
  scope: CollaborationScope,
  threadId: string,
  anchor?: string,
) {
  return infiniteQueryOptions({
    queryKey: [
      ...collaborationKeys.scope(scope),
      'discussion',
      threadId,
      anchor,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      readDiscussion(scope, threadId, pageParam, anchor, signal),
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: COLLABORATION_LIMITS.pollMs,
    gcTime: 0,
    retry: false,
  });
}
export function peopleQuery(scope: CollaborationScope, q: string) {
  return infiniteQueryOptions({
    queryKey: [...collaborationKeys.scope(scope), 'people', q],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => readPeople(scope, q, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 10000,
    gcTime: 0,
    retry: false,
  });
}
export function presenceQuery(scope: CollaborationScope, tabId: string) {
  return queryOptions({
    queryKey: [...collaborationKeys.scope(scope), 'presence', tabId],
    queryFn: ({ signal }) => readPresence(scope, tabId, signal),
    refetchInterval: COLLABORATION_LIMITS.pollMs,
    staleTime: 5000,
    gcTime: 0,
    retry: false,
  });
}
