import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { getUsageCapacity } from './usage.api';

export function usageCapacityQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  return queryOptions({
    queryKey: [
      'identity',
      userId,
      'workspace',
      workspaceId,
      'usage-capacity',
    ] as const,
    queryFn: ({ signal }) => getUsageCapacity(apiClient, workspaceId, signal),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}
