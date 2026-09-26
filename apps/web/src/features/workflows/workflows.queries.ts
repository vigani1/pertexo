import {
  infiniteQueryOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  WorkflowListResponse,
  WorkflowSummary,
} from '@pertexo/contracts/schemas/workflow-authoring';
import type { ApiClient } from '@/lib/api/client';
import type { WorkflowListOrder } from './model/workflow-list-view';
import {
  getWorkflowShapeGraph,
  getWorkflowSummary,
  getWorkflowsPage,
} from './workflows.api';

export const workflowKeys = {
  scope: (userId: string, workspaceId: string) =>
    ['identity', userId, 'workspace', workspaceId, 'workflows'] as const,
  lists: (userId: string, workspaceId: string) =>
    [...workflowKeys.scope(userId, workspaceId), 'list'] as const,
  list: (userId: string, workspaceId: string, order: WorkflowListOrder) =>
    [...workflowKeys.lists(userId, workspaceId), order] as const,
  recent: (userId: string, workspaceId: string) =>
    [...workflowKeys.scope(userId, workspaceId), 'recent'] as const,
  detail: (userId: string, workspaceId: string, workflowId: string) =>
    [...workflowKeys.scope(userId, workspaceId), 'detail', workflowId] as const,
  shape: (userId: string, workspaceId: string, workflowId: string) =>
    [...workflowKeys.scope(userId, workspaceId), 'shape', workflowId] as const,
};

const initialWorkflowPageParam: string | null = null;

/** Workflow pages, newest activity first unless the list asks otherwise. */
export function workflowsInfiniteQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  order: WorkflowListOrder = 'updated_desc',
) {
  return infiniteQueryOptions({
    queryKey: workflowKeys.list(userId, workspaceId, order),
    queryFn: ({ pageParam, signal }) =>
      getWorkflowsPage(apiClient, workspaceId, {
        order,
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

/**
 * A workflow summary the app already holds: its own read, else its row in a
 * loaded list, so a page opened from a list can name the workflow before its
 * own read lands.
 */
export function cachedWorkflowSummary(
  queryClient: QueryClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
): WorkflowSummary | undefined {
  const own = queryClient.getQueryData<WorkflowSummary>(
    workflowKeys.detail(userId, workspaceId, workflowId),
  );
  if (own !== undefined) return own;
  const pages = [
    ...queryClient
      .getQueriesData<InfiniteData<WorkflowListResponse>>({
        queryKey: workflowKeys.lists(userId, workspaceId),
      })
      .flatMap(([, data]) => data?.pages ?? []),
    queryClient.getQueryData<WorkflowListResponse>(
      workflowKeys.recent(userId, workspaceId),
    ),
  ];
  return pages
    .flatMap((page) => page?.items ?? [])
    .find((workflow) => workflow.id === workflowId);
}

/**
 * A workflow's draft graph for its pattern glyph, path sentence and trigger
 * icons. Shapes change rarely compared with how often lists render, so rows
 * reuse a cached shape for minutes instead of re-reading every draft.
 */
export function workflowShapeQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  return queryOptions({
    queryKey: workflowKeys.shape(userId, workspaceId, workflowId),
    queryFn: ({ signal }) =>
      getWorkflowShapeGraph(apiClient, workspaceId, workflowId, signal),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
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
