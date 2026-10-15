import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { PendingTaskListQuery } from '@pertexo/contracts';
import { listTasks, getTask, listAudience, type TaskScope } from './tasks.api';
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
    staleTime: 10_000,
    refetchInterval: 30_000,
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
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data?.task.status === 'pending' ? 15_000 : false,
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
    staleTime: 30_000,
  });
}
