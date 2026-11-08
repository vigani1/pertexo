import { workflowSettingsKeys } from '@/features/workflow-settings/workflow-settings-queries.public';
import { workflowKeys } from '@/features/workflows/workflows-queries.public';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { getLatestWorkflowVersion } from './workflow-publish.api';

const workflowPublishKeys = {
  latestVersion: (userId: string, workspaceId: string, workflowId: string) =>
    [
      'identity',
      userId,
      'workspace',
      workspaceId,
      'workflow',
      workflowId,
      'latest-version',
    ] as const,
};

/** The newest published version, for "Publish vN" and the change summary. */
export function latestVersionQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  return queryOptions({
    queryKey: workflowPublishKeys.latestVersion(
      userId,
      workspaceId,
      workflowId,
    ),
    queryFn: ({ signal }) =>
      getLatestWorkflowVersion(apiClient, workspaceId, workflowId, signal),
    staleTime: 60_000,
  });
}

/** Every publication entry point refreshes the snapshots that describe the live version. */
export async function invalidatePublishedWorkflow(
  cache: QueryClient,
  scope: Readonly<{ userId: string; workspaceId: string }>,
  workflowId: string,
) {
  await Promise.all([
    cache.invalidateQueries({
      queryKey: workflowKeys.scope(scope.userId, scope.workspaceId),
    }),
    cache.invalidateQueries({
      queryKey: workflowPublishKeys.latestVersion(
        scope.userId,
        scope.workspaceId,
        workflowId,
      ),
    }),
    cache.invalidateQueries({
      queryKey: workflowSettingsKeys.root(
        scope.userId,
        scope.workspaceId,
        workflowId,
      ),
    }),
  ]);
}
