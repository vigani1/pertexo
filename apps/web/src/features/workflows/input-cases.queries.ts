import {
  infiniteQueryOptions,
  skipToken,
  useInfiniteQuery,
} from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
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

/** Observe the existing list gate; never guess from errors or mirror its state. */
export function useInputCasesAvailability(
  scope:
    | Readonly<{
        apiClient: ApiClient;
        userId: string;
        workspaceId: string;
        workflowId: string;
      }>
    | undefined,
  enabled: boolean,
) {
  const query = useInfiniteQuery({
    ...inputCasesQueryOptions(
      scope?.apiClient,
      scope?.userId ?? '',
      scope?.workspaceId ?? '',
      scope?.workflowId ?? '',
    ),
    enabled: enabled && scope !== undefined,
  });
  if (query.isFetching) return undefined;
  if (
    isApiError(query.error) &&
    query.error.problem?.code === 'workflow.input_cases_unavailable'
  )
    return false;
  return query.isSuccess ? true : undefined;
}
