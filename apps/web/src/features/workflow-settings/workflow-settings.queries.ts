import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { failureNotificationDestinationsQueryOptions } from '@/features/failure-notifications/public';
import { findWorkflowSummary } from '@/features/workflows/public';
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
  summary: (userId: string, workspaceId: string, workflowId: string) =>
    [
      ...workflowSettingsKeys.root(userId, workspaceId, workflowId),
      'summary',
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

export function workflowSettingsQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  return {
    summary: queryOptions({
      queryKey: workflowSettingsKeys.summary(userId, workspaceId, workflowId),
      queryFn: ({ signal }) =>
        findWorkflowSummary(apiClient, workspaceId, workflowId, signal),
    }),
    versions: queryOptions({
      queryKey: workflowSettingsKeys.versions(userId, workspaceId, workflowId),
      queryFn: ({ signal }) =>
        getAllWorkflowVersions(apiClient, workspaceId, workflowId, signal),
    }),
    schedules: queryOptions({
      queryKey: workflowSettingsKeys.schedules(userId, workspaceId, workflowId),
      queryFn: ({ signal }) =>
        getScheduleTriggers(apiClient, workspaceId, workflowId, signal),
    }),
    webhooks: queryOptions({
      queryKey: workflowSettingsKeys.webhooks(userId, workspaceId, workflowId),
      queryFn: ({ signal }) =>
        getWebhookTriggers(apiClient, workspaceId, workflowId, signal),
    }),
    destinations: failureNotificationDestinationsQueryOptions(
      apiClient,
      userId,
      workspaceId,
    ),
  } as const;
}
