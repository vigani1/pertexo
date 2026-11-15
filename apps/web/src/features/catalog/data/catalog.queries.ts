import { QUERY_FRESHNESS } from '@/lib/api/query-timings';
import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { getAuthoringCatalog } from './catalog.api';

export function authoringCatalogQueryOptions(
  apiClient: ApiClient,
  userId: string,
) {
  return queryOptions({
    queryKey: ['identity', userId, 'authoring-catalog'] as const,
    queryFn: ({ signal }) => getAuthoringCatalog(apiClient, signal),
    staleTime: QUERY_FRESHNESS.catalog,
  });
}
