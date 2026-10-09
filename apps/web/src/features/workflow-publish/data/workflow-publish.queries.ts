import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { getLatestWorkflowVersion } from './workflow-publish.api';

export const workflowPublishKeys = {
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
