import { QUERY_FRESHNESS } from '@/lib/api/query-timings';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { getErrorWorkflow, getErrorTargets } from './error-workflow.api';

export const errorWorkflowKey = (
  userId: string,
  workspaceId: string,
  workflowId: string,
) =>
  [
    'identity',
    userId,
    'workspace',
    workspaceId,
    'workflow-error-policy',
    workflowId,
  ] as const;
export function errorWorkflowQuery(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  const queryKey = errorWorkflowKey(userId, workspaceId, workflowId);
  return queryOptions({
    queryKey,
    queryFn: async ({ signal, client }) => {
      try {
        return await getErrorWorkflow(
          apiClient,
          workspaceId,
          workflowId,
          signal,
        );
      } catch (error) {
        if (isApiError(error) && [401, 403, 404].includes(error.status ?? 0))
          client
            .getQueryCache()
            .find({ queryKey, exact: true })
            ?.setState({ data: undefined, dataUpdatedAt: 0 });
        throw error;
      }
    },
    staleTime: QUERY_FRESHNESS.none,
  });
}
export function errorTargetsQuery(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  return infiniteQueryOptions({
    queryKey: [...errorWorkflowKey(userId, workspaceId, workflowId), 'targets'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      getErrorTargets({
        client: apiClient,
        workspaceId,
        workflowId,
        after: pageParam,
        signal,
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: QUERY_FRESHNESS.none,
  });
}
