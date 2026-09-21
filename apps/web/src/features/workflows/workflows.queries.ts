import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { getWorkflowSummary, getWorkflowsPage } from './workflows.api';

export const workflowKeys = {
  scope: (userId: string, workspaceId: string) =>
    ['identity', userId, 'workspace', workspaceId, 'workflows'] as const,
  list: (userId: string, workspaceId: string) =>
    [...workflowKeys.scope(userId, workspaceId), 'list'] as const,
  recent: (userId: string, workspaceId: string) =>
    [...workflowKeys.scope(userId, workspaceId), 'recent'] as const,
  detail: (userId: string, workspaceId: string, workflowId: string) =>
    [...workflowKeys.scope(userId, workspaceId), 'detail', workflowId] as const,
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

export function workflowSummaryQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  return queryOptions({
    queryKey: workflowKeys.detail(userId, workspaceId, workflowId),
    queryFn: ({ signal }) =>
      getWorkflowSummary(apiClient, workspaceId, workflowId, signal),
    staleTime: 30_000,
  });
}

export function recentWorkflowsQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  return queryOptions({
    queryKey: workflowKeys.recent(userId, workspaceId),
    queryFn: ({ signal }) =>
      getWorkflowsPage(apiClient, workspaceId, {
        limit: 5,
        order: 'updated_desc',
        signal,
      }),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}
