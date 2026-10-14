import { infiniteQueryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { getApiTokensPage } from './api-tokens.api';

export const apiTokenKeys = {
  list: (userId: string, workspaceId: string) =>
    ['identity', userId, 'workspace', workspaceId, 'api-tokens'] as const,
};

export function apiTokensQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  return infiniteQueryOptions({
    queryKey: apiTokenKeys.list(userId, workspaceId),
    queryFn: ({ pageParam, signal }) =>
      getApiTokensPage(apiClient, workspaceId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 10_000,
  });
}
