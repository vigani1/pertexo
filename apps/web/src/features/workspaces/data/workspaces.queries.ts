import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import {
  getAllAccessibleWorkspaces,
  getWorkspaceMembersPage,
  getWorkspaceInvitationsPage,
} from './workspaces.api';

export const workspaceMemberKeys = {
  list: (userId: string, workspaceId: string) =>
    ['identity', userId, 'workspace', workspaceId, 'members'] as const,
};
export const workspaceInvitationKeys = {
  list: (userId: string, workspaceId: string) =>
    ['identity', userId, 'workspace', workspaceId, 'invitations'] as const,
};
export const workspaceKeys = {
  accessible: (userId: string) =>
    ['identity', userId, 'accessible-workspaces'] as const,
};

export function accessibleWorkspacesQueryOptions(
  apiClient: ApiClient,
  userId: string,
) {
  return queryOptions({
    queryKey: workspaceKeys.accessible(userId),
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

export function workspaceInvitationsInfiniteQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  return infiniteQueryOptions({
    queryKey: workspaceInvitationKeys.list(userId, workspaceId),
    queryFn: ({ pageParam, signal }) =>
      getWorkspaceInvitationsPage(apiClient, workspaceId, {
        ...(pageParam === null ? {} : { after: pageParam }),
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}
