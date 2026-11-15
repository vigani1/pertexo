import { QUERY_FRESHNESS, QUERY_RETENTION } from '@/lib/api/query-timings';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { AuditFilter } from '@pertexo/contracts';
import { readAudit, readSettings, type GovernanceScope } from './audit.api';
export const governanceKeys = {
  scope: (scope: GovernanceScope) =>
    [
      'identity',
      scope.userId,
      'workspace',
      scope.workspaceId,
      'governance',
    ] as const,
};
export function auditQueryOptions(
  scope: GovernanceScope,
  filters: AuditFilter,
) {
  return infiniteQueryOptions({
    queryKey: [...governanceKeys.scope(scope), 'audit', filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      readAudit(scope, filters, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
    staleTime: QUERY_FRESHNESS.standard,
    gcTime: QUERY_RETENTION.none,
  });
}
export function governanceQueryOptions(scope: GovernanceScope) {
  return queryOptions({
    queryKey: [...governanceKeys.scope(scope), 'settings'],
    queryFn: ({ signal }) => readSettings(scope, signal),
    retry: false,
    staleTime: QUERY_FRESHNESS.standard,
    gcTime: QUERY_RETENTION.none,
  });
}
