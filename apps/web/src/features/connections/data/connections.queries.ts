import type { ConnectionLookupRequest } from '@pertexo/contracts';
import { QUERY_FRESHNESS, QUERY_POLLING } from '@/lib/api/query-timings';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { isNotFound } from '@/lib/api/error-copy';
import type { ApiClient } from '@/lib/api/client';
import { forgetDeniedSnapshots } from '@/lib/api/read-denial';
import {
  getAllConnections,
  getConnection,
  getConnectionUsagePage,
  getConnectionsPage,
  lookupConnectionOptions,
} from './connections.api';

export const connectionKeys = {
  scope: (userId: string, workspaceId: string) =>
    ['identity', userId, 'workspace', workspaceId, 'connections'] as const,
  list: (userId: string, workspaceId: string) =>
    [...connectionKeys.scope(userId, workspaceId), 'list'] as const,
  discovery: (userId: string, workspaceId: string) =>
    [...connectionKeys.scope(userId, workspaceId), 'discovery'] as const,
  editor: (userId: string, workspaceId: string) =>
    [...connectionKeys.scope(userId, workspaceId), 'editor'] as const,
  detail: (userId: string, workspaceId: string, connectionId: string) =>
    [
      ...connectionKeys.scope(userId, workspaceId),
      'detail',
      connectionId,
    ] as const,
  /** Every connection's usage read, as one prefix. */
  usages: (userId: string, workspaceId: string) =>
    [...connectionKeys.scope(userId, workspaceId), 'usage'] as const,
  usage: (userId: string, workspaceId: string, connectionId: string) =>
    [...connectionKeys.usages(userId, workspaceId), connectionId] as const,
};

export function connectionOptions({
  apiClient,
  userId,
  workspaceId,
  connectionId,
  request,
  staleTime,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  connectionId: string;
  request: ConnectionLookupRequest;
  staleTime?: number;
}>) {
  return queryOptions({
    queryKey: [
      ...connectionKeys.scope(userId, workspaceId),
      'lookup',
      connectionId,
      request,
    ],
    queryFn: ({ signal }) =>
      lookupConnectionOptions(
        apiClient,
        workspaceId,
        connectionId,
        request,
        signal,
      ),
    retry: false,
    ...(staleTime === undefined ? {} : { staleTime }),
  });
}

const initialConnectionPageParam: string | null = null;

export function connectionsInfiniteQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  const queryKey = connectionKeys.list(userId, workspaceId);
  return infiniteQueryOptions({
    queryKey,
    queryFn: async ({ pageParam, signal, client }) => {
      try {
        return await getConnectionsPage(apiClient, workspaceId, {
          ...(pageParam === null ? {} : { after: pageParam }),
          signal,
        });
      } catch (error: unknown) {
        await forgetDeniedSnapshots(
          client,
          connectionKeys.scope(userId, workspaceId),
          queryKey,
          error,
        );
        throw error;
      }
    },
    initialPageParam: initialConnectionPageParam,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: QUERY_POLLING.status,
    refetchIntervalInBackground: false,
  });
}

export function connectionDiscoveryQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  const queryKey = connectionKeys.discovery(userId, workspaceId);
  return queryOptions({
    queryKey,
    queryFn: async ({ signal, client }) => {
      try {
        return await getAllConnections(apiClient, workspaceId, signal);
      } catch (error: unknown) {
        await forgetDeniedSnapshots(
          client,
          connectionKeys.scope(userId, workspaceId),
          queryKey,
          error,
        );
        throw error;
      }
    },
    staleTime: QUERY_FRESHNESS.standard,
  });
}

/**
 * Every connection a workflow editor can offer its steps, or `null` when the
 * API answers 404 because connections can't be read here (a local API
 * without connection encryption has no connection routes). The editor then
 * opens without connections instead of failing; other failures still throw.
 */
export function editorConnectionsQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  return queryOptions({
    queryKey: connectionKeys.editor(userId, workspaceId),
    queryFn: async ({ signal, client }) => {
      try {
        return await getAllConnections(apiClient, workspaceId, signal);
      } catch (error) {
        await forgetDeniedSnapshots(
          client,
          connectionKeys.scope(userId, workspaceId),
          connectionKeys.editor(userId, workspaceId),
          error,
        );
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    staleTime: QUERY_FRESHNESS.standard,
  });
}

export function connectionDetailQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  connectionId: string,
) {
  const queryKey = connectionKeys.detail(userId, workspaceId, connectionId);
  return queryOptions({
    queryKey,
    queryFn: async ({ signal, client }) => {
      try {
        return await getConnection(
          apiClient,
          workspaceId,
          connectionId,
          signal,
        );
      } catch (error: unknown) {
        await forgetDeniedSnapshots(
          client,
          connectionKeys.scope(userId, workspaceId),
          queryKey,
          error,
        );
        throw error;
      }
    },
    refetchInterval: QUERY_POLLING.status,
    refetchIntervalInBackground: false,
  });
}

export function connectionUsageQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  connectionId: string,
) {
  const queryKey = connectionKeys.usage(userId, workspaceId, connectionId);
  return infiniteQueryOptions({
    queryKey,
    queryFn: async ({ pageParam, signal, client }) => {
      try {
        return await getConnectionUsagePage(
          apiClient,
          workspaceId,
          connectionId,
          {
            ...(pageParam === null ? {} : { after: pageParam }),
            signal,
          },
        );
      } catch (error: unknown) {
        // Workflow-read loss denies usage, not otherwise authorized connection metadata.
        await forgetDeniedSnapshots(client, queryKey, queryKey, error);
        throw error;
      }
    },
    initialPageParam: initialConnectionPageParam,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: QUERY_POLLING.status,
    refetchIntervalInBackground: false,
  });
}
