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
      readDiscussion({ scope, threadId, before: pageParam, anchor, signal }),
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
const STEP_COUNT_THREADS = 100;
const STEP_COUNT_PAGES = Math.ceil(
  STEP_COUNT_THREADS / COLLABORATION_LIMITS.page,
);

/** Open discussions per step, read from the first pages of open threads. */
export function stepDiscussionsQuery(scope: CollaborationScope) {
  return queryOptions({
    queryKey: [...collaborationKeys.scope(scope), 'step-discussions'],
    queryFn: async ({ signal }) => {
      const counts = new Map<string, number>();
      let after: string | null = null;
      // These pages reach the hundred most recent open threads; a canvas
      // with more open discussions than that has bigger problems.
      for (let page = 0; page < STEP_COUNT_PAGES; page += 1) {
        const threads = await readThreads(
          scope,
          { status: 'open', scope: 'all' },
          after,
          signal,
        );
        for (const thread of threads.items)
          if (thread.stepId !== null)
            counts.set(thread.stepId, (counts.get(thread.stepId) ?? 0) + 1);
        if (threads.nextCursor === null) break;
        after = threads.nextCursor;
      }
      return counts;
    },
    refetchInterval: COLLABORATION_LIMITS.pollMs * 3,
    staleTime: COLLABORATION_LIMITS.pollMs,
    retry: false,
  });
}
