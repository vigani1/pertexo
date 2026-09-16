import { queryOptions } from '@tanstack/react-query';
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
