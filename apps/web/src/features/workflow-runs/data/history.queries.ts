import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import type { RunHistoryFilters } from '../model/list/run-search';
import { getWorkflowRunsPage } from './workflow-runs.api';
import { workflowRunKeys, forgetUnavailableRunReads } from './query-cache';

export function workflowRunsInfiniteQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  filters: RunHistoryFilters,
) {
  const queryKey = workflowRunKeys.history(userId, workspaceId, filters);
  return infiniteQueryOptions({
    queryKey,
    queryFn: async ({ pageParam, signal, client }) => {
      try {
        return await getWorkflowRunsPage(apiClient, workspaceId, filters, {
          ...(pageParam === null ? {} : { after: pageParam }),
          signal,
        });
      } catch (error: unknown) {
        await forgetUnavailableRunReads(
          client,
          [...workflowRunKeys.scope(userId, workspaceId), 'history'],
          queryKey,
          error,
        );
        throw error;
      }
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

/** Whether the workspace has ever run anything (for the first-run guide). */
export function anyRunQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  return queryOptions({
    queryKey: workflowRunKeys.anyRun(userId, workspaceId),
    queryFn: async ({ signal }) => {
      const page = await getWorkflowRunsPage(
        apiClient,
        workspaceId,
        {},
        { limit: 1, signal },
      );
      return page.items.length > 0;
    },
    staleTime: 60_000,
  });
}
