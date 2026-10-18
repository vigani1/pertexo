import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import {
  readPromotionSettings,
  readPromotionVersions,
  readPromotionCandidates,
  readPromotionHistory,
  type PromotionScope,
} from './promotions.api';
export const promotionKeys = {
  scope: (scope: PromotionScope) =>
    [
      'identity',
      scope.userId,
      'workspace',
      scope.workspaceId,
      'promotions',
    ] as const,
};
export function promotionSettingsQuery(scope: PromotionScope) {
  return queryOptions({
    queryKey: [...promotionKeys.scope(scope), 'settings'],
    queryFn: ({ signal }) => readPromotionSettings(scope, signal),
    staleTime: 10000,
    gcTime: 0,
    retry: false,
  });
}
export function promotionCandidatesQuery(
  scope: PromotionScope,
  search: string,
) {
  return infiniteQueryOptions({
    queryKey: [...promotionKeys.scope(scope), 'candidates', search],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      readPromotionCandidates(scope, pageParam, search, signal),
    getNextPageParam: (page) => page.nextCursor,
    gcTime: 0,
    retry: false,
  });
}
export function promotionHistoryQuery(scope: PromotionScope) {
  return infiniteQueryOptions({
    queryKey: [...promotionKeys.scope(scope), 'history'],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      readPromotionHistory(scope, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor,
    gcTime: 0,
    retry: false,
  });
}

export function promotionVersionsQuery(
  scope: PromotionScope,
  workflowId: string,
) {
  return infiniteQueryOptions({
    queryKey: [...promotionKeys.scope(scope), 'versions', workflowId],
    initialPageParam: null as number | null,
    queryFn: ({ signal, pageParam }) =>
      readPromotionVersions(scope, workflowId, pageParam, signal),
    getNextPageParam: (page) => page.nextVersionNumber,
    gcTime: 0,
    retry: false,
  });
}
