import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { getWorkflowAutoPause, getWorkspaceAutoPause } from './auto-pause.api';

export const autoPauseKeys = {
  workspace: (userId: string, workspaceId: string) =>
    ['identity', userId, 'workspace', workspaceId, 'auto-pause'] as const,
  workflowRoot: (userId: string, workspaceId: string) =>
    [
      'identity',
      userId,
      'workspace',
      workspaceId,
      'workflow-auto-pause',
    ] as const,
  workflow: (userId: string, workspaceId: string, workflowId: string) =>
    [...autoPauseKeys.workflowRoot(userId, workspaceId), workflowId] as const,
};

export function workflowAutoPauseQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  return queryOptions({
    queryKey: autoPauseKeys.workflow(userId, workspaceId, workflowId),
    queryFn: ({ signal }) =>
      getWorkflowAutoPause(apiClient, workspaceId, workflowId, signal),
    staleTime: 0,
    refetchInterval: 30_000,
  });
}

export function workspaceAutoPauseQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  return queryOptions({
    queryKey: autoPauseKeys.workspace(userId, workspaceId),
    queryFn: ({ signal }) =>
      getWorkspaceAutoPause(apiClient, workspaceId, signal),
    staleTime: 0,
  });
}
