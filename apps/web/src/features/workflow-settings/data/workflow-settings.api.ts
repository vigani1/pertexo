import {
  workflowFailureNotificationPolicyRequestSchema,
  workflowFailureNotificationPolicyResponseSchema,
  type WorkflowFailureNotificationPolicyResponse,
  scheduleFireTimesResponseSchema,
  scheduleManagementCommandResponseSchema,
  scheduleOccurrenceListResponseSchema,
  scheduleTriggerListResponseSchema,
  type ScheduleFireTimesResponse,
  type ScheduleManagementCommandResponse,
  type ScheduleOccurrenceListResponse,
  webhookDeliveryListResponseSchema,
  webhookAuthenticationSchema,
  type WebhookAuthentication,
  webhookManagementCommandResponseSchema,
  webhookRotateSecretRequestSchema,
  webhookTriggerListResponseSchema,
  type WebhookDeliveryListResponse,
  type WebhookManagementCommandResponse,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { searchParams } from '@/lib/api/pagination';

function workflowPath(workspaceId: string, workflowId: string): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}`;
}

export function getScheduleTriggers(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal?: AbortSignal,
) {
  return apiClient.request({
    path: `${workflowPath(workspaceId, workflowId)}/triggers/schedules`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => scheduleTriggerListResponseSchema.parse(value),
    },
  });
}

function triggerPath(
  workspaceId: string,
  workflowId: string,
  triggerId: string,
): `/v1${string}` {
  return `${workflowPath(workspaceId, workflowId)}/triggers/${encodeURIComponent(triggerId)}`;
}

/** When a published schedule fires next, by the scheduler's own rules. */
export function getScheduleNextRuns({
  apiClient,
  workspaceId,
  workflowId,
  triggerId,
  signal,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  triggerId: string;
  signal?: AbortSignal | undefined;
}>): Promise<ScheduleFireTimesResponse> {
  return apiClient.request({
    path: `${triggerPath(workspaceId, workflowId, triggerId)}/schedule/next-runs?${searchParams({ count: 3 })}`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => scheduleFireTimesResponseSchema.parse(value),
    },
  });
}

/** One page of a schedule's retained occurrences, newest first. */
export function getScheduleOccurrencesPage({
  apiClient,
  workspaceId,
  workflowId,
  triggerId,
  input = {},
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  triggerId: string;
  input?: Readonly<{ after?: string; signal?: AbortSignal }> | undefined;
}>): Promise<ScheduleOccurrenceListResponse> {
  const query = searchParams({ limit: 10, after: input.after });
  return apiClient.request({
    path: `${triggerPath(workspaceId, workflowId, triggerId)}/schedule/occurrences?${query}`,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    response: {
      kind: 'json',
      decode: (value) => scheduleOccurrenceListResponseSchema.parse(value),
    },
  });
}

export function setScheduleEnabled({
  apiClient,
  workspaceId,
  workflowId,
  triggerId,
  enabled,
  idempotencyKey,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  triggerId: string;
  enabled: boolean;
  idempotencyKey: string;
}>): Promise<ScheduleManagementCommandResponse> {
  return apiClient.request({
    path: `${workflowPath(workspaceId, workflowId)}/triggers/${encodeURIComponent(triggerId)}/schedule/${enabled ? 'enable' : 'disable'}`,
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {},
    response: {
      kind: 'json',
      decode: (value) => scheduleManagementCommandResponseSchema.parse(value),
    },
  });
}

export function getWebhookTriggers(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal?: AbortSignal,
) {
  return apiClient.request({
    path: `${workflowPath(workspaceId, workflowId)}/triggers`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => webhookTriggerListResponseSchema.parse(value),
    },
  });
}

/** One page of a webhook's retained delivery metadata, newest first. */
export function getWebhookDeliveriesPage({
  apiClient,
  workspaceId,
  workflowId,
  triggerId,
  input = {},
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  triggerId: string;
  input?: Readonly<{ after?: string; signal?: AbortSignal }> | undefined;
}>): Promise<WebhookDeliveryListResponse> {
  const query = searchParams({ limit: 10, after: input.after });
  return apiClient.request({
    path: `${workflowPath(workspaceId, workflowId)}/triggers/${encodeURIComponent(triggerId)}/webhook/deliveries?${query}`,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    response: {
      kind: 'json',
      decode: (value) => webhookDeliveryListResponseSchema.parse(value),
    },
  });
}

export function commandWebhook({
  apiClient,
  workspaceId,
  workflowId,
  triggerId,
  input,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  triggerId: string;
  input:
    | Readonly<{
        command: 'provision' | 'rotate-endpoint';
        idempotencyKey: string;
      }>
    | Readonly<{
        command: 'authentication';
        authentication: WebhookAuthentication;
        idempotencyKey: string;
      }>
    | Readonly<{
        command: 'rotate-secret';
        endpointKey: string;
        idempotencyKey: string;
      }>;
}>): Promise<WebhookManagementCommandResponse> {
  const body = webhookCommandBody(input);
  return apiClient.request({
    path: `${workflowPath(workspaceId, workflowId)}/triggers/${encodeURIComponent(triggerId)}/webhook/${input.command}`,
    method: 'POST',
    headers: { 'Idempotency-Key': input.idempotencyKey },
    ...(body === undefined ? {} : { body }),
    response: {
      kind: 'json',
      decode: (value) => webhookManagementCommandResponseSchema.parse(value),
    },
  });
}

/** Where this workflow's failure alerts go now; `destination` is null when off. */
export function getFailureNotificationPolicy(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal?: AbortSignal,
): Promise<WorkflowFailureNotificationPolicyResponse> {
  return apiClient.request({
    path: `${workflowPath(workspaceId, workflowId)}/failure-notification-policy`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) =>
        workflowFailureNotificationPolicyResponseSchema.parse(value),
    },
  });
}

export function setFailureNotificationPolicy({
  apiClient,
  workspaceId,
  workflowId,
  destinationId,
  idempotencyKey,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  destinationId: string;
  idempotencyKey: string;
}>): Promise<void> {
  return apiClient.request({
    path: `${workflowPath(workspaceId, workflowId)}/failure-notification-policy`,
    method: 'PUT',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: workflowFailureNotificationPolicyRequestSchema.parse({
      destinationId,
    }),
    response: { kind: 'empty' },
  });
}

export function clearFailureNotificationPolicy(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  idempotencyKey: string,
): Promise<void> {
  return apiClient.request({
    path: `${workflowPath(workspaceId, workflowId)}/failure-notification-policy`,
    method: 'DELETE',
    headers: { 'Idempotency-Key': idempotencyKey },
    response: { kind: 'empty' },
  });
}

function webhookCommandBody(
  input: Parameters<typeof commandWebhook>[0]['input'],
) {
  if (input.command === 'authentication')
    return webhookAuthenticationSchema.parse(input.authentication);
  if (input.command === 'rotate-secret')
    return webhookRotateSecretRequestSchema.parse({
      endpointKey: input.endpointKey,
    });
  return undefined;
}
