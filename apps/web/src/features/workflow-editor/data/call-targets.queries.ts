import {
  infiniteQueryOptions,
  queryOptions,
  skipToken,
} from '@tanstack/react-query';
import {
  findWorkflowVersion,
  getWorkflowVersionsPage,
} from '@/features/workflow-versions/public';
import type { ApiClient } from '@/lib/api/client';

export type CallTargetScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
}>;

function targetKey(scope: CallTargetScope, targetWorkflowId: string | null) {
  return [
    'identity',
    scope.userId,
    'workspace',
    scope.workspaceId,
    'call-target-versions',
    targetWorkflowId,
  ] as const;
}

export function callTargetVersionsQueryOptions(
  scope: CallTargetScope,
  targetWorkflowId: string | null,
) {
  return infiniteQueryOptions({
    queryKey: [...targetKey(scope, targetWorkflowId), 'pages'] as const,
    queryFn:
      targetWorkflowId === null
        ? skipToken
        : ({ pageParam, signal }) =>
            getWorkflowVersionsPage(
              scope.apiClient,
              scope.workspaceId,
              targetWorkflowId,
              {
                ...(pageParam === null ? {} : { after: pageParam }),
                signal,
              },
            ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
  });
}

/** An old pin is one exact read, independent of browsing newer history pages. */
export function callPinnedVersionQueryOptions(
  scope: CallTargetScope,
  pin: Readonly<{ workflowId: string; workflowVersionId: string }> | undefined,
) {
  return queryOptions({
    queryKey: [
      ...targetKey(scope, pin?.workflowId ?? null),
      'pin',
      pin?.workflowVersionId ?? null,
    ] as const,
    queryFn:
      pin === undefined
        ? skipToken
        : ({ signal }) =>
            findWorkflowVersion({
              apiClient: scope.apiClient,
              workspaceId: scope.workspaceId,
              workflowId: pin.workflowId,
              versionId: pin.workflowVersionId,
              signal,
            }),
    staleTime: Infinity,
  });
}
