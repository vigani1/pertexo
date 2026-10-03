import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { getAllWorkflowVersions } from '@/features/workflow-versions/public';
import {
  getWorkflowsPage,
  workflowKeys,
} from '@/features/workflows/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { versionSourceWorkflowPageState } from './model/inspector/version-source-pagination';

export type VersionSourceScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
}>;

/** Separate source-discovery cache; ordinary workflow lists never seed this read. */
export function workflowSourcesInfiniteQueryOptions(scope: VersionSourceScope) {
  return infiniteQueryOptions({
    queryKey: [
      ...workflowKeys.scope(scope.userId, scope.workspaceId),
      'version-source-workflows',
    ] as const,
    queryFn: ({
      pageParam,
      signal,
    }: {
      pageParam: string | null;
      signal: AbortSignal;
    }) =>
      getWorkflowsPage(scope.apiClient, scope.workspaceId, {
        order: 'updated_desc',
        ...(pageParam === null ? {} : { after: pageParam }),
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage, pages, _lastParam, pageParams) =>
      versionSourceWorkflowPageState(pages, pageParams).canLoadMore
        ? (lastPage.nextCursor ?? undefined)
        : undefined,
    retry: false,
  });
}

/** Source discovery only; the response carries no executable eligibility. */
export function workflowVersionSourcesQueryOptions(
  scope: VersionSourceScope,
  workflowId: string,
) {
  return queryOptions({
    queryKey: [
      ...workflowKeys.detail(scope.userId, scope.workspaceId, workflowId),
      'version-sources',
    ] as const,
    queryFn: ({ signal }) =>
      getAllWorkflowVersions(
        scope.apiClient,
        scope.workspaceId,
        workflowId,
        signal,
      ),
    staleTime: 30_000,
    retry: false,
  });
}
