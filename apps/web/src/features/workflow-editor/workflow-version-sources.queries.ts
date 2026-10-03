import { queryOptions } from '@tanstack/react-query';
import { getAllWorkflowVersions } from '@/features/workflow-versions/public';
import { workflowKeys } from '@/features/workflows/queries.public';
import type { ApiClient } from '@/lib/api/client';

export type VersionSourceScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
}>;

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
