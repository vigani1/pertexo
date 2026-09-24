import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { getAllWorkflowVersions } from '@/features/workflow-versions/public';
import {
  getScheduleTriggers,
  getWebhookTriggers,
} from './workflow-settings.api';

export const workflowSettingsKeys = {
  root: (userId: string, workspaceId: string, workflowId: string) =>
    [
      'identity',
      userId,
      'workspace',
      workspaceId,
      'workflow',
      workflowId,
      'settings',
    ] as const,
  versions: (userId: string, workspaceId: string, workflowId: string) =>
    [
      ...workflowSettingsKeys.root(userId, workspaceId, workflowId),
      'versions',
    ] as const,
  schedules: (userId: string, workspaceId: string, workflowId: string) =>
    [
      ...workflowSettingsKeys.root(userId, workspaceId, workflowId),
      'schedules',
    ] as const,
  webhooks: (userId: string, workspaceId: string, workflowId: string) =>
    [
      ...workflowSettingsKeys.root(userId, workspaceId, workflowId),
      'webhooks',
    ] as const,
};

/** Every published version, newest first. */
export function workflowVersionsQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  return queryOptions({
    queryKey: workflowSettingsKeys.versions(userId, workspaceId, workflowId),
    queryFn: async ({ signal }) => {
      const response = await getAllWorkflowVersions(
        apiClient,
        workspaceId,
        workflowId,
        signal,
      );
      return {
        ...response,
        items: response.items
          .slice()
          .sort((a, b) => b.versionNumber - a.versionNumber),
      };
    },
  });
}

export function scheduleTriggersQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  return queryOptions({
    queryKey: workflowSettingsKeys.schedules(userId, workspaceId, workflowId),
    queryFn: ({ signal }) =>
      getScheduleTriggers(apiClient, workspaceId, workflowId, signal),
  });
}

export function webhookTriggersQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  return queryOptions({
    queryKey: workflowSettingsKeys.webhooks(userId, workspaceId, workflowId),
    queryFn: ({ signal }) =>
      getWebhookTriggers(apiClient, workspaceId, workflowId, signal),
  });
}
