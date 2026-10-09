import { infiniteQueryOptions, skipToken } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { listInputCases } from './input-cases.api';
import { workflowKeys } from './workflows.queries';

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
  api: ApiClient | undefined,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  return infiniteQueryOptions({
    queryKey: inputCasesKey(userId, workspaceId, workflowId),
    initialPageParam: undefined as string | undefined,
    queryFn:
      api === undefined
        ? skipToken
        : ({ signal, pageParam }) =>
            listInputCases(api, workspaceId, workflowId, signal, pageParam),
    getNextPageParam: (page, _pages, _pageParam, pageParams) =>
      page.nextCursor !== undefined && !pageParams.includes(page.nextCursor)
        ? page.nextCursor
        : undefined,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
