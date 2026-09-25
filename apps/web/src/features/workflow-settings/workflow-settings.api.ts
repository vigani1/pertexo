import {
  workflowFailureNotificationPolicyRequestSchema,
  workflowFailureNotificationPolicyResponseSchema,
  type WorkflowFailureNotificationPolicyResponse,
} from '@pertexo/contracts/schemas/failure-notifications';
import {
  scheduleManagementCommandResponseSchema,
  scheduleTriggerListResponseSchema,
  type ScheduleManagementCommandResponse,
} from '@pertexo/contracts/schemas/schedules';
import {
  webhookManagementCommandResponseSchema,
  webhookRotateSecretRequestSchema,
  webhookTriggerListResponseSchema,
  type WebhookManagementCommandResponse,
} from '@pertexo/contracts/schemas/webhooks';
import type { ApiClient } from '@/lib/api/client';

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

export function setScheduleEnabled(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  triggerId: string,
  enabled: boolean,
  idempotencyKey: string,
): Promise<ScheduleManagementCommandResponse> {
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

export function commandWebhook(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  triggerId: string,
  input:
    | Readonly<{
        command: 'provision' | 'rotate-endpoint';
        idempotencyKey: string;
      }>
    | Readonly<{
        command: 'rotate-secret';
        endpointKey: string;
        idempotencyKey: string;
      }>,
): Promise<WebhookManagementCommandResponse> {
  const body =
    input.command === 'rotate-secret'
      ? webhookRotateSecretRequestSchema.parse({
          endpointKey: input.endpointKey,
        })
      : undefined;
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

export function setFailureNotificationPolicy(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  destinationId: string,
  idempotencyKey: string,
): Promise<void> {
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
