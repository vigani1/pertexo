import { useInfiniteQuery } from '@tanstack/react-query';
import { workflowOrganizationListResponseSchema } from '@pertexo/contracts/schemas/workflow-authoring';
import type { ApiClient } from '@/lib/api/client';
import { workflowOrganizationInfiniteQueryOptions } from './organization.queries';
import {
  WORKFLOW_ORDER_BY_SORT,
  type WorkflowListSearch,
} from './model/workflow-list-view';

/** A separate strict cache and cursor identity; no previous-filter rows. */
export function useOrganizationList(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  search: WorkflowListSearch,
  enabled: boolean,
) {
  return useInfiniteQuery({
    ...workflowOrganizationInfiniteQueryOptions(
      apiClient,
      userId,
      workspaceId,
      {
        include: 'organization',
        order: WORKFLOW_ORDER_BY_SORT[search.sort ?? 'updated'],
        view: search.view ?? 'active',
        query: search.query,
        tagId: search.tagId,
        folderId: search.folderId,
        favoritesOnly: search.favoritesOnly,
      },
    ),
    enabled,
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
}
