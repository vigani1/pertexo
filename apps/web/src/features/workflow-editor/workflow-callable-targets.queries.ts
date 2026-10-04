import { queryOptions } from '@tanstack/react-query';
import {
  getWorkflowCallableTargetsPage,
  getWorkflowCallableTargetVersion,
} from '@/features/workflow-versions/public';
import { workflowKeys } from '@/features/workflows/queries.public';
import type { ApiClient } from '@/lib/api/client';

type CallableTargetScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
}>;

function callableTargetKey(scope: CallableTargetScope, workflowId: string) {
  return [
    ...workflowKeys.detail(scope.userId, scope.workspaceId, workflowId),
    'callableTarget',
  ] as const;
}

/** Explicit page only; source-version/list caches cannot seed this projection. */
export function workflowCallableTargetsPageQueryOptions(
  scope: CallableTargetScope,
  workflowId: string,
  input: Readonly<{ limit?: number; after?: string }> = {},
) {
  const limit = input.limit ?? 1;
  return queryOptions({
    queryKey: [
      ...callableTargetKey(scope, workflowId),
      'page',
      { limit, after: input.after ?? null },
    ] as const,
    queryFn: ({ signal }) =>
      getWorkflowCallableTargetsPage(
        scope.apiClient,
        scope.workspaceId,
        workflowId,
        { ...input, signal },
      ),
    staleTime: 0,
    retry: false,
  });
}

/** Inspection snapshot only. Confirmation must perform a fresh exact HTTP read. */
export function workflowCallableTargetVersionQueryOptions(
  scope: CallableTargetScope,
  workflowId: string,
  versionId: string,
) {
  return queryOptions({
    queryKey: [
      ...callableTargetKey(scope, workflowId),
      'version',
      versionId,
    ] as const,
    queryFn: ({ signal }) =>
      getWorkflowCallableTargetVersion(
        scope.apiClient,
        scope.workspaceId,
        workflowId,
        versionId,
        signal,
      ),
    staleTime: 0,
    retry: false,
  });
}
