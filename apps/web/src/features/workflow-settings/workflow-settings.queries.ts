import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { getAllWorkflowVersions } from '@/features/workflow-versions/public';
import {
  getFailureNotificationPolicy,
  getScheduleNextRuns,
  getScheduleOccurrencesPage,
  getScheduleTriggers,
  getWebhookDeliveriesPage,
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
  failurePolicy: (userId: string, workspaceId: string, workflowId: string) =>
    [
      ...workflowSettingsKeys.root(userId, workspaceId, workflowId),
      'failure-policy',
    ] as const,
  scheduleNextRuns: (
    userId: string,
    workspaceId: string,
    workflowId: string,
    triggerId: string,
  ) =>
    [
      ...workflowSettingsKeys.schedules(userId, workspaceId, workflowId),
      triggerId,
      'next-runs',
    ] as const,
  scheduleOccurrences: (
    userId: string,
    workspaceId: string,
    workflowId: string,
    triggerId: string,
  ) =>
    [
      ...workflowSettingsKeys.schedules(userId, workspaceId, workflowId),
      triggerId,
      'occurrences',
    ] as const,
  webhookDeliveries: (
    userId: string,
    workspaceId: string,
    workflowId: string,
    triggerId: string,
  ) =>
    [
      ...workflowSettingsKeys.webhooks(userId, workspaceId, workflowId),
      triggerId,
      'deliveries',
    ] as const,
};

const initialPageParam: string | null = null;
const MAX_TIMER_MS = 2_147_483_647;

/** A webhook's retained delivery log, one page of ten at a time. */
export function webhookDeliveriesInfiniteQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
  triggerId: string,
) {
  return infiniteQueryOptions({
    queryKey: workflowSettingsKeys.webhookDeliveries(
      userId,
      workspaceId,
      workflowId,
      triggerId,
    ),
    queryFn: ({ pageParam, signal }) =>
      getWebhookDeliveriesPage(apiClient, workspaceId, workflowId, triggerId, {
        ...(pageParam === null ? {} : { after: pageParam }),
        signal,
      }),
    initialPageParam,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

/** The next three times a published schedule fires; under its schedule key. */
export function scheduleNextRunsQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
  triggerId: string,
) {
  return queryOptions({
    queryKey: workflowSettingsKeys.scheduleNextRuns(
      userId,
      workspaceId,
      workflowId,
      triggerId,
    ),
    queryFn: ({ signal }) =>
      getScheduleNextRuns(
        apiClient,
        workspaceId,
        workflowId,
        triggerId,
        signal,
      ),
    // Ask again once the first run time has passed, but no more than twice
    // a minute while a due run waits for the scheduler.
    refetchInterval: (query) => {
      const first = query.state.data?.items[0]?.scheduledAt;
      if (first === undefined) return false;
      const untilPassed = Date.parse(first) - Date.now() + 1_000;
      return Math.min(Math.max(untilPassed, 30_000), MAX_TIMER_MS);
    },
  });
}

/** A schedule's retained occurrences, one page of ten at a time. */
export function scheduleOccurrencesInfiniteQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
  triggerId: string,
) {
  return infiniteQueryOptions({
    queryKey: workflowSettingsKeys.scheduleOccurrences(
      userId,
      workspaceId,
      workflowId,
      triggerId,
    ),
    queryFn: ({ pageParam, signal }) =>
      getScheduleOccurrencesPage(
        apiClient,
        workspaceId,
        workflowId,
        triggerId,
        { ...(pageParam === null ? {} : { after: pageParam }), signal },
      ),
    initialPageParam,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

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

/** The workflow's current failure-alert destination, or none. */
export function failureNotificationPolicyQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  return queryOptions({
    queryKey: workflowSettingsKeys.failurePolicy(
      userId,
      workspaceId,
      workflowId,
    ),
    queryFn: ({ signal }) =>
      getFailureNotificationPolicy(apiClient, workspaceId, workflowId, signal),
  });
}
