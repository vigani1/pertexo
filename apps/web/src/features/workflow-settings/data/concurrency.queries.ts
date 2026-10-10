import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { getWorkflowConcurrency } from './concurrency.api';

export const concurrencyKey = (
  userId: string,
  workspaceId: string,
  workflowId: string,
) =>
  [
    'identity',
    userId,
    'workspace',
    workspaceId,
    'workflow-concurrency',
    workflowId,
  ] as const;

export function concurrencyQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  const queryKey = concurrencyKey(userId, workspaceId, workflowId);
  return queryOptions({
    queryKey,
    queryFn: async ({ signal, client }) => {
      try {
        return await getWorkflowConcurrency(
          apiClient,
          workspaceId,
          workflowId,
          signal,
        );
      } catch (error: unknown) {
        if (
          isApiError(error) &&
          [401, 403, 404, 409].includes(error.status ?? 0)
        ) {
          // A later transient failure must never restore a prohibited snapshot.
          client
            .getQueryCache()
            .find({ queryKey, exact: true })
            ?.setState({ data: undefined, dataUpdatedAt: 0 });
        }
        throw error;
      }
    },
    staleTime: 0,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}
