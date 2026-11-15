import {
  QUERY_FRESHNESS,
  QUERY_POLLING,
  QUERY_RETENTION,
} from '@/lib/api/query-timings';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type {
  ApprovalAudienceInspectionRequest,
  PendingTaskListQuery,
} from '@pertexo/contracts';
import {
  listTasks,
  getTask,
  listAudience,
  inspectAudience,
  type TaskScope,
} from './tasks.api';
export const taskKeys = {
  scope: (userId: string, workspaceId: string) =>
    ['identity', userId, 'workspace', workspaceId, 'pending-tasks'] as const,
};
export function tasksQueryOptions(
  scope: TaskScope,
  input: Omit<PendingTaskListQuery, 'after'>,
) {
  return infiniteQueryOptions({
    queryKey: [
      ...taskKeys.scope(scope.userId, scope.workspaceId),
      'list',
      input,
    ],
    queryFn: ({ pageParam, signal }) =>
      listTasks(
        scope,
        { ...input, ...(pageParam === null ? {} : { after: pageParam }) },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: QUERY_FRESHNESS.working,
    refetchInterval: QUERY_POLLING.status,
  });
}
export function taskQueryOptions(scope: TaskScope, taskId: string) {
  return queryOptions({
    queryKey: [
      ...taskKeys.scope(scope.userId, scope.workspaceId),
      'detail',
      taskId,
    ],
    queryFn: ({ signal }) => getTask(scope, taskId, signal),
    staleTime: QUERY_FRESHNESS.live,
    refetchInterval: (query) =>
      query.state.data?.task.status === 'pending'
        ? QUERY_POLLING.pendingTask
        : false,
  });
}
export function audienceQueryOptions(scope: TaskScope, q: string) {
  return infiniteQueryOptions({
    queryKey: [
      ...taskKeys.scope(scope.userId, scope.workspaceId),
      'audience',
      q,
    ],
    queryFn: ({ pageParam, signal }) =>
      listAudience(scope, q, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: QUERY_FRESHNESS.standard,
  });
}

export function audienceInspectionQueryOptions(
  scope: TaskScope,
  audience: ApprovalAudienceInspectionRequest['audience'],
) {
  return queryOptions({
    queryKey: [
      ...taskKeys.scope(scope.userId, scope.workspaceId),
      'audience-inspection',
      audience,
    ],
    queryFn: ({ signal }) => inspectAudience(scope, audience, signal),
    staleTime: QUERY_FRESHNESS.working,
    gcTime: QUERY_RETENTION.none,
    retry: false,
  });
}
