import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { getCurrentUser } from './auth.api';

const currentUserQueryKey = ['identity', 'current-user'] as const;

export function currentUserQueryOptions(apiClient: ApiClient) {
  return queryOptions({
    queryKey: currentUserQueryKey,
    queryFn: ({ signal }) => getCurrentUser(apiClient, signal),
    staleTime: 0,
    gcTime: 5 * 60_000,
  });
}
