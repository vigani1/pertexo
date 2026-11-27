import { QUERY_FRESHNESS, QUERY_POLLING } from '@/lib/api/query-timings';
import { isActiveRunStatus } from '../model/presentation/run-status';
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
    staleTime: QUERY_FRESHNESS.settled,
  });
}

/**
 * A workflow's newest run, or null before its first. Asked again while
 * that run is still going, so a run started elsewhere shows up as well.
 */
export function latestWorkflowRunQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  return queryOptions({
    queryKey: workflowRunKeys.latest(userId, workspaceId, workflowId),
    queryFn: async ({ signal }) => {
      const page = await getWorkflowRunsPage(
        apiClient,
        workspaceId,
        { workflowId },
        { limit: 1, signal },
      );
      return page.items[0] ?? null;
    },
    staleTime: QUERY_FRESHNESS.live,
    refetchInterval: (query) => {
      const run = query.state.data;
      return run !== null && run !== undefined && isActiveRunStatus(run.status)
        ? QUERY_POLLING.live
        : QUERY_POLLING.status;
    },
  });
}
