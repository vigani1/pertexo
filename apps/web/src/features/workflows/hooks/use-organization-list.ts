import { useInfiniteQuery } from '@tanstack/react-query';
import { workflowOrganizationListResponseSchema } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { workflowListQueryOptions } from '../data/organization/queries';
import type { WorkflowListSearch } from '../model/list-view';
import {
  isOrganizationReadDenied,
  useOrganizationReadLifetime,
} from './use-organization-read-lifetime';

/** A separate strict cache and cursor identity; no previous-filter rows. */
export function useOrganizationList(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  search: WorkflowListSearch,
) {
  const lifetime = useOrganizationReadLifetime(userId, workspaceId);
  const query = useInfiniteQuery({
    ...workflowListQueryOptions(apiClient, userId, workspaceId, search),
    enabled: lifetime.error === undefined,
    select: (data) => ({
      ...data,
      pages: data.pages.map((page) => {
        const current = workflowOrganizationListResponseSchema.parse(page);
        return {
          items: current.items.map((item) => item.workflow),
          nextCursor: current.nextCursor,
          organizations: current.items,
        };
      }),
    }),
  });
  const error =
    lifetime.error ??
    (isOrganizationReadDenied(query.error) ? query.error : undefined);
  const refetch: typeof query.refetch = async (options) => {
    const result = await query.refetch(options);
    if (result.isSuccess) lifetime.restore();
    return result;
  };
  // Expose only list state and actions; spreading the Query observer would
  // subscribe this owner to every tracked field, including unused metadata.
  return {
    data: error === undefined ? query.data : undefined,
    error: error ?? query.error,
    dataUpdatedAt: query.dataUpdatedAt,
    isPending: error === undefined && query.isPending,
    isError: error !== undefined || query.isError,
    isSuccess: error === undefined && query.isSuccess,
    isFetching: query.isFetching,
    isFetchingNextPage: query.isFetchingNextPage,
    isRefetchError: error === undefined && query.isRefetchError,
    isFetchNextPageError: error === undefined && query.isFetchNextPageError,
    hasNextPage: error === undefined && query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    refetch,
  };
}
