import type {
  WorkspaceNoticeKind,
  WorkspaceInboxFilter,
} from '@pertexo/contracts';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { getInboxSummary, getInboxThreads } from './inbox.api';

export const inboxKeys = {
  scope: (userId: string, workspaceId: string) =>
    ['identity', userId, 'workspace', workspaceId, 'inbox'] as const,
  summary: (userId: string, workspaceId: string) =>
    [...inboxKeys.scope(userId, workspaceId), 'summary'] as const,
  threads: (
    userId: string,
    workspaceId: string,
    filter: WorkspaceInboxFilter,
    noticeKind?: WorkspaceNoticeKind,
  ) =>
    [
      ...inboxKeys.scope(userId, workspaceId),
      'threads',
      filter,
      noticeKind ?? 'all',
    ] as const,
};

/**
 * The unread count the spine shows. Live hints refresh it; the interval only
 * covers a stream that cannot connect.
 */
export function inboxSummaryQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  return queryOptions({
    queryKey: inboxKeys.summary(userId, workspaceId),
    queryFn: ({ signal }) => getInboxSummary(apiClient, workspaceId, signal),
    staleTime: 15_000,
    refetchInterval: 120_000,
  });
}

export function inboxThreadsInfiniteQueryOptions({
  apiClient,
  userId,
  workspaceId,
  filter,
  noticeKind,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  filter: WorkspaceInboxFilter;
  noticeKind?: WorkspaceNoticeKind | undefined;
}>) {
  return infiniteQueryOptions({
    queryKey: inboxKeys.threads(userId, workspaceId, filter, noticeKind),
    queryFn: ({ pageParam, signal }) =>
      getInboxThreads(apiClient, workspaceId, {
        filter,
        ...(noticeKind === undefined ? {} : { noticeKind }),
        ...(pageParam === null ? {} : { after: pageParam }),
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 15_000,
  });
}
