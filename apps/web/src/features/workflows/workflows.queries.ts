import { infiniteQueryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { getWorkflowsPage } from './workflows.api';

export const workflowKeys = {
  list: (userId: string, workspaceId: string) =>
    ['identity', userId, 'workspace', workspaceId, 'workflows'] as const,
};

const initialWorkflowPageParam: string | null = null;

export function workflowsInfiniteQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  return infiniteQueryOptions({
    queryKey: workflowKeys.list(userId, workspaceId),
    queryFn: ({ pageParam, signal }) =>
      getWorkflowsPage(apiClient, workspaceId, {
        ...(pageParam === null ? {} : { after: pageParam }),
        signal,
      }),
    initialPageParam: initialWorkflowPageParam,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}
