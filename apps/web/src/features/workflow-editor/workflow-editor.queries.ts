import { queryOptions } from '@tanstack/react-query';
import { findWorkflowVersion } from '@/features/workflow-versions/public';
import type { ApiClient } from '@/lib/api/client';
import { getWorkflowDraft } from './workflow-editor.api';

export const workflowDraftKeys = {
  detail: (userId: string, workspaceId: string, workflowId: string) =>
    [
      'identity',
      userId,
      'workspace',
      workspaceId,
      'workflow',
      workflowId,
      'draft',
    ] as const,
};

export function workflowDraftQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  return queryOptions({
    queryKey: workflowDraftKeys.detail(userId, workspaceId, workflowId),
    queryFn: ({ signal }) =>
      getWorkflowDraft(apiClient, workspaceId, workflowId, signal),
    staleTime: 0,
  });
}

/**
 * The published version a workflow runs, for "Live v4" in the command bar.
 * Versions never change, so one read is enough.
 */
export function liveVersionQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
  versionId: string,
) {
  const workflowKey = workflowDraftKeys
    .detail(userId, workspaceId, workflowId)
    .slice(0, -1);
  return queryOptions({
    queryKey: [...workflowKey, 'version', versionId] as const,
    queryFn: ({ signal }) =>
      findWorkflowVersion(
        apiClient,
        workspaceId,
        workflowId,
        versionId,
        signal,
      ),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
