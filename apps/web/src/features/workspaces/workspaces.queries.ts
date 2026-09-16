import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import {
  getAllAccessibleWorkspaces,
  getWorkspaceLifecycleOperation,
  getWorkspaceMembersPage,
} from './workspaces.api';

export const workspaceMemberKeys = {
  list: (userId: string, workspaceId: string) =>
    ['identity', userId, 'workspace', workspaceId, 'members'] as const,
};

const workspaceLifecycleKeys = {
  operation: (userId: string, workspaceId: string, operationId: string) =>
    [
      'identity',
      userId,
      'workspace',
      workspaceId,
      'lifecycle-operation',
      operationId,
    ] as const,
};

export function accessibleWorkspacesQueryOptions(
  apiClient: ApiClient,
  userId: string,
) {
  return queryOptions({
    queryKey: ['identity', userId, 'accessible-workspaces'] as const,
    queryFn: ({ signal }) => getAllAccessibleWorkspaces(apiClient, signal),
    staleTime: 30_000,
  });
}

export function workspaceMembersInfiniteQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  return infiniteQueryOptions({
    queryKey: workspaceMemberKeys.list(userId, workspaceId),
    queryFn: ({ pageParam, signal }) =>
      getWorkspaceMembersPage(apiClient, workspaceId, {
        ...(pageParam === null ? {} : { after: pageParam }),
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function workspaceLifecycleOperationQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  operationId: string,
) {
  return queryOptions({
    queryKey: workspaceLifecycleKeys.operation(
      userId,
      workspaceId,
      operationId,
    ),
    queryFn: ({ signal }) =>
      getWorkspaceLifecycleOperation(
        apiClient,
        workspaceId,
        operationId,
        signal,
      ),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'pending' || status === 'running' ? 1_000 : false;
    },
  });
}
