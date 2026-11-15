import { QUERY_FRESHNESS, QUERY_RETENTION } from '@/lib/api/query-timings';
import { queryOptions, infiniteQueryOptions } from '@tanstack/react-query';
import { readVariables, readVariableUsage } from './variables.api';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
export const variableKeys = {
  scope: (scope: WorkspaceApiScope) =>
    [
      'identity',
      scope.userId,
      'workspace',
      scope.workspaceId,
      'variables',
    ] as const,
};
export function variablesQueryOptions(scope: WorkspaceApiScope) {
  return queryOptions({
    queryKey: [...variableKeys.scope(scope), 'current'],
    queryFn: ({ signal }) => readVariables(scope, signal),
    staleTime: QUERY_FRESHNESS.working,
    gcTime: QUERY_RETENTION.none,
    retry: false,
  });
}
export function variableUsageQueryOptions(
  scope: WorkspaceApiScope,
  name: string,
) {
  return infiniteQueryOptions({
    queryKey: [...variableKeys.scope(scope), 'usage', name],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      readVariableUsage(scope, name, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor,
    staleTime: QUERY_FRESHNESS.none,
    gcTime: QUERY_RETENTION.none,
    // A refetch would walk every page again from the first.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}
