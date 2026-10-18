import { queryOptions } from '@tanstack/react-query';
import { readSettings, type FederationScope } from './settings.api';
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
    staleTime: 30000,
    gcTime: 0,
    retry: false,
  });
}
