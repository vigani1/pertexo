import { QUERY_FRESHNESS, QUERY_RETENTION } from '@/lib/api/query-timings';
import { queryOptions } from '@tanstack/react-query';
import { readSettings, type FederationScope } from './federation-settings.api';
const federationKeys = {
  scope: (scope: FederationScope) =>
    [
      'identity',
      scope.userId,
      'workspace',
      scope.workspaceId,
      'federation',
    ] as const,
};
export function federationSettingsQueryOptions(scope: FederationScope) {
  return queryOptions({
    queryKey: federationKeys.scope(scope),
    queryFn: ({ signal }) => readSettings(scope, signal),
    staleTime: QUERY_FRESHNESS.standard,
    gcTime: QUERY_RETENTION.none,
    retry: false,
  });
}
