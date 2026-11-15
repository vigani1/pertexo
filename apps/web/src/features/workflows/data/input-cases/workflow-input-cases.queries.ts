import { QUERY_FRESHNESS, QUERY_RETENTION } from '@/lib/api/query-timings';
import { infiniteQueryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { listInputCases } from './workflow-input-cases.api';
import { workflowKeys } from '../workflows.queries';

export const inputCasesKey = (
  userId: string,
  workspaceId: string,
  workflowId: string,
) =>
  [
    ...workflowKeys.detail(userId, workspaceId, workflowId),
    'input-cases',
  ] as const;

export function inputCasesQueryOptions(
  api: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  return infiniteQueryOptions({
    queryKey: inputCasesKey(userId, workspaceId, workflowId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      listInputCases({
        api,
        workspaceId,
        workflowId,
        signal,
        after: pageParam,
      }),
    getNextPageParam: (page, _pages, _pageParam, pageParams) =>
      page.nextCursor !== undefined && !pageParams.includes(page.nextCursor)
        ? page.nextCursor
        : undefined,
    staleTime: QUERY_FRESHNESS.none,
    gcTime: QUERY_RETENTION.none,
    retry: false,
  });
}
