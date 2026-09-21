import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { findWorkflowVersion } from '@/features/workflow-versions/public';
import type { RunHistoryFilters } from './run-history.types';
import { getWorkflowRun, getWorkflowRunsPage } from './workflow-runs.api';

export const workflowRunKeys = {
  scope: (userId: string, workspaceId: string) =>
    ['identity', userId, 'workspace', workspaceId, 'runs'] as const,
  history: (userId: string, workspaceId: string, filters: RunHistoryFilters) =>
    [
      ...workflowRunKeys.scope(userId, workspaceId),
      'history',
      filters,
    ] as const,
  detail: (userId: string, workspaceId: string, runId: string) =>
    [...workflowRunKeys.scope(userId, workspaceId), 'detail', runId] as const,
  recent: (userId: string, workspaceId: string, status: 'all' | 'failed') =>
    [...workflowRunKeys.scope(userId, workspaceId), 'recent', status] as const,
};

export function workflowRunsInfiniteQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  filters: RunHistoryFilters,
) {
  return infiniteQueryOptions({
    queryKey: workflowRunKeys.history(userId, workspaceId, filters),
    queryFn: ({ pageParam, signal }) =>
      getWorkflowRunsPage(apiClient, workspaceId, filters, {
        ...(pageParam === null ? {} : { after: pageParam }),
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function recentWorkflowRunsQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  status: 'all' | 'failed',
) {
  return queryOptions({
    queryKey: workflowRunKeys.recent(userId, workspaceId, status),
    queryFn: ({ signal }) =>
      getWorkflowRunsPage(
        apiClient,
        workspaceId,
        status === 'failed' ? { status: 'failed' } : {},
        { limit: 5, signal },
      ),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function workflowRunQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  runId: string,
) {
  return queryOptions({
    queryKey: workflowRunKeys.detail(userId, workspaceId, runId),
    queryFn: ({ signal }) =>
      getWorkflowRun(apiClient, workspaceId, runId, signal),
    staleTime: 0,
  });
}

export function workflowRunVersionQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
  versionId: string,
) {
  return queryOptions({
    queryKey: [
      'identity',
      userId,
      'workspace',
      workspaceId,
      'workflow',
      workflowId,
      'version',
      versionId,
    ] as const,
    queryFn: ({ signal }) =>
      findWorkflowVersion(
        apiClient,
        workspaceId,
        workflowId,
        versionId,
        signal,
      ),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
