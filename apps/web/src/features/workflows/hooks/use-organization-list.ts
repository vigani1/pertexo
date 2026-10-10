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
  return error === undefined
    ? { ...query, refetch }
    : {
        ...query,
        data: undefined,
        error,
        status: 'error' as const,
        isError: true as const,
        isPending: false as const,
        isSuccess: false as const,
        isLoading: false as const,
        isLoadingError: true as const,
        isRefetchError: false as const,
        isFetchNextPageError: false as const,
        isFetchPreviousPageError: false as const,
        isPlaceholderData: false as const,
        refetch,
      };
}
