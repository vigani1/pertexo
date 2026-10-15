import { queryOptions, infiniteQueryOptions } from '@tanstack/react-query';
import {
  readVariables,
  readVariableUsage,
  type VariablesScope,
} from './variables.api';
export const variableKeys = {
  scope: (scope: VariablesScope) =>
    [
      'identity',
      scope.userId,
      'workspace',
      scope.workspaceId,
      'variables',
    ] as const,
};
export function variablesQueryOptions(scope: VariablesScope) {
  return queryOptions({
    queryKey: [...variableKeys.scope(scope), 'current'],
    queryFn: ({ signal }) => readVariables(scope, signal),
    staleTime: 10000,
    gcTime: 0,
    retry: false,
  });
}
export function variableUsageQueryOptions(scope: VariablesScope, name: string) {
  return infiniteQueryOptions({
    queryKey: [...variableKeys.scope(scope), 'usage', name],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      readVariableUsage(scope, name, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
