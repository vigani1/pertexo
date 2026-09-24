import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import {
  getAllConnections,
  getConnection,
  getConnectionsPage,
} from './connections.api';

export const connectionKeys = {
  scope: (userId: string, workspaceId: string) =>
    ['identity', userId, 'workspace', workspaceId, 'connections'] as const,
  list: (userId: string, workspaceId: string) =>
    [...connectionKeys.scope(userId, workspaceId), 'list'] as const,
  discovery: (userId: string, workspaceId: string) =>
    [...connectionKeys.scope(userId, workspaceId), 'discovery'] as const,
  detail: (userId: string, workspaceId: string, connectionId: string) =>
    [
      ...connectionKeys.scope(userId, workspaceId),
      'detail',
      connectionId,
    ] as const,
};

const initialConnectionPageParam: string | null = null;

export function connectionsInfiniteQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  return infiniteQueryOptions({
    queryKey: connectionKeys.list(userId, workspaceId),
    queryFn: ({ pageParam, signal }) =>
      getConnectionsPage(apiClient, workspaceId, {
        ...(pageParam === null ? {} : { after: pageParam }),
        signal,
      }),
    initialPageParam: initialConnectionPageParam,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function connectionDiscoveryQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  return queryOptions({
    queryKey: connectionKeys.discovery(userId, workspaceId),
    queryFn: ({ signal }) => getAllConnections(apiClient, workspaceId, signal),
    staleTime: 30_000,
  });
}

export function connectionDetailQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  connectionId: string,
) {
  return queryOptions({
    queryKey: connectionKeys.detail(userId, workspaceId, connectionId),
    queryFn: ({ signal }) =>
      getConnection(apiClient, workspaceId, connectionId, signal),
  });
}
