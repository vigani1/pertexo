import { queryOptions, skipToken } from '@tanstack/react-query';
import { getAllWorkflowVersions } from '@/features/workflow-versions/public';
import type { ApiClient } from '@/lib/api/client';

export type CallTargetScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
}>;

export function callTargetVersionsQueryOptions(
  scope: CallTargetScope,
  targetWorkflowId: string | null,
) {
  return queryOptions({
    queryKey: [
      'identity',
      scope.userId,
      'workspace',
      scope.workspaceId,
      'call-target-versions',
      targetWorkflowId,
    ] as const,
    queryFn:
      targetWorkflowId === null
        ? skipToken
        : ({ signal }) =>
            getAllWorkflowVersions(
              scope.apiClient,
              scope.workspaceId,
              targetWorkflowId,
              signal,
            ),
    staleTime: 30_000,
    select: (response) =>
      response.items.filter((version) => version.graph.callable !== undefined),
  });
}
