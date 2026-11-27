import { workflowSummaryQueryOptions } from '@/features/workflows/workflows-queries.public';
import { QUERY_POLLING } from '@/lib/api/query-timings';
import { readWallClock } from '@/lib/wall-clock';
import { MAX_TIMER_MS } from '@/lib/timer';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import {
  getAllWorkflowVersions,
  getWorkflowVersionHistory,
} from '@/features/workflow-versions/workflow-versions-queries.public';
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
// Ask a moment after the first run time, once the scheduler has had it, but
// no more than twice a minute while a due run waits for the scheduler.
const SCHEDULE_PASS_MARGIN_MS = 1_000;
const SCHEDULE_RECHECK_FLOOR_MS = 30_000;

/** When to read a schedule's next runs again, or false with none due. */
function nextScheduleRead(
  firstScheduledAt: string | undefined,
  now: () => number,
): number | false {
  if (firstScheduledAt === undefined) return false;
  const untilPassed =
    Date.parse(firstScheduledAt) - now() + SCHEDULE_PASS_MARGIN_MS;
  return Math.min(
    Math.max(untilPassed, SCHEDULE_RECHECK_FLOOR_MS),
    MAX_TIMER_MS,
  );
}

/** A webhook's retained delivery log, one page of ten at a time. */
export function webhookDeliveriesInfiniteQueryOptions({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  triggerId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  triggerId: string;
}>) {
  return infiniteQueryOptions({
    queryKey: workflowSettingsKeys.webhookDeliveries(
      userId,
      workspaceId,
      workflowId,
      triggerId,
    ),
    queryFn: ({ pageParam, signal }) =>
      getWebhookDeliveriesPage({
        apiClient,
        workspaceId,
        workflowId,
        triggerId,
        input: {
          ...(pageParam === null ? {} : { after: pageParam }),
          signal,
        },
      }),
    initialPageParam,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

/** A published schedule’s next fire times, including those due today. */
export function scheduleNextRunsQueryOptions({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  triggerId,
  now = readWallClock,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  triggerId: string;
  now?: () => number;
}>) {
  return queryOptions({
    queryKey: workflowSettingsKeys.scheduleNextRuns(
      userId,
      workspaceId,
      workflowId,
      triggerId,
    ),
    queryFn: ({ signal }) =>
      getScheduleNextRuns({
        apiClient,
        workspaceId,
        workflowId,
        triggerId,
        signal,
      }),
    refetchInterval: (query) =>
      nextScheduleRead(query.state.data?.items[0]?.scheduledAt, now),
  });
}

/** A schedule's retained occurrences, one page of ten at a time. */
export function scheduleOccurrencesInfiniteQueryOptions({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  triggerId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  triggerId: string;
}>) {
  return infiniteQueryOptions({
    queryKey: workflowSettingsKeys.scheduleOccurrences(
      userId,
      workspaceId,
      workflowId,
      triggerId,
    ),
    queryFn: ({ pageParam, signal }) =>
      getScheduleOccurrencesPage({
        apiClient,
        workspaceId,
        workflowId,
        triggerId,
        input: { ...(pageParam === null ? {} : { after: pageParam }), signal },
      }),
    initialPageParam,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

/** Every published version for graph and trigger reads. */
export function workflowVersionsQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  return queryOptions({
    queryKey: workflowSettingsKeys.versions(userId, workspaceId, workflowId),
    queryFn: ({ signal }) =>
      getAllWorkflowVersions(apiClient, workspaceId, workflowId, signal),
  });
}

/** Every published version, newest first, with its visible publisher. */
export function workflowVersionHistoryQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  return queryOptions({
    queryKey: [
      ...workflowSettingsKeys.versions(userId, workspaceId, workflowId),
      'history',
    ] as const,
    queryFn: async ({ signal }) => {
      const response = await getWorkflowVersionHistory(
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

export function triggerPublicationQueryOptions(
  ...args: Parameters<typeof workflowSummaryQueryOptions>
) {
  const summary = workflowSummaryQueryOptions(...args);
  return queryOptions({
    ...summary,
    refetchInterval: (query) => {
      const polling = query.state.data?.pollingTriggers ?? [];
      if (polling.some(({ healthStatus }) => healthStatus === 'pending'))
        return QUERY_POLLING.settling;
      if (polling.some(({ healthStatus }) => healthStatus !== 'disabled'))
        return QUERY_POLLING.status;
      return typeof summary.refetchInterval === 'function'
        ? summary.refetchInterval(query)
        : false;
    },
  });
}
