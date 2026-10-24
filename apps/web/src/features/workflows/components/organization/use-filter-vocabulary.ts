import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import {
  workflowFoldersQueryOptions,
  workflowTagsInfiniteQueryOptions,
} from '../../data/organization/queries';
import {
  isOrganizationReadDenied,
  useOrganizationReadLifetime,
} from '../../hooks/use-organization-read-lifetime';

/** Own the authorized vocabulary lifetime independently of whether its popup is open. */
export function useWorkflowFilterVocabulary(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  const lifetime = useOrganizationReadLifetime(userId, workspaceId);
  const folders = useQuery({
    ...workflowFoldersQueryOptions(apiClient, userId, workspaceId),
    enabled: lifetime.error === undefined,
  });
  const tags = useInfiniteQuery({
    ...workflowTagsInfiniteQueryOptions(apiClient, userId, workspaceId),
    enabled: lifetime.error === undefined,
  });
  const denied =
    lifetime.error !== undefined ||
    isOrganizationReadDenied(folders.error) ||
    isOrganizationReadDenied(tags.error);
  return {
    folders: denied ? undefined : folders.data?.items,
    tags: denied ? undefined : tags.data?.pages.flatMap((page) => page.items),
    denied,
    failed: denied || folders.isError || tags.isError,
    showing: folders.data !== undefined || tags.data !== undefined,
    hasMoreTags: !denied && tags.hasNextPage,
    loadingTags: tags.isFetchingNextPage,
    failedNextTags: tags.isFetchNextPageError,
    loadMoreTags: () => void tags.fetchNextPage(),
    retry: () => {
      void Promise.all([folders.refetch(), tags.refetch()]).then((results) => {
        if (results.every((result) => result.isSuccess)) lifetime.restore();
      });
    },
  };
}
