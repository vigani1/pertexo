import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import {
  getAllConnections,
  getConnection,
  getConnectionsPage,
  getSlackChannelNames,
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
  slackChannels: (
    userId: string,
    workspaceId: string,
    connectionId: string,
    channelIds: readonly string[],
  ) =>
    [
      ...connectionKeys.scope(userId, workspaceId),
      'slack-channels',
      connectionId,
      channelIds.join(','),
    ] as const,
};

/**
 * Channel names change rarely and each lookup spends the connection's
 * provider-test allowance, so names stay fresh for five minutes.
 */
export function slackChannelNamesQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  connectionId: string,
  channelIds: readonly string[],
) {
  return queryOptions({
    queryKey: connectionKeys.slackChannels(
      userId,
      workspaceId,
      connectionId,
      channelIds,
    ),
    queryFn: ({ signal }) =>
      getSlackChannelNames(
        apiClient,
        workspaceId,
        connectionId,
        channelIds,
        signal,
      ),
    staleTime: 5 * 60_000,
  });
}

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
