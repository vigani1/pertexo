import {
  failureNotificationDestinationAppendVersionRequestSchema,
  failureNotificationDestinationCreateRequestSchema,
  failureNotificationDestinationListResponseSchema,
  failureNotificationDestinationResponseSchema,
  failureNotificationDestinationStatusRequestSchema,
  type FailureNotificationDestinationConfig,
  type FailureNotificationDestinationResponse,
} from '@pertexo/contracts/schemas/failure-notifications';
import type { ApiClient } from '@/lib/api/client';

function destinationsPath(workspaceId: string): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/failure-notification-destinations`;
}

export function getFailureNotificationDestinations(
  apiClient: ApiClient,
  workspaceId: string,
  signal?: AbortSignal,
) {
  return apiClient.request({
    path: destinationsPath(workspaceId),
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) =>
        failureNotificationDestinationListResponseSchema.parse(value),
    },
  });
}

export function createFailureNotificationDestination(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{
    config: FailureNotificationDestinationConfig;
    idempotencyKey: string;
  }>,
): Promise<FailureNotificationDestinationResponse> {
  return apiClient.request({
    path: destinationsPath(workspaceId),
    method: 'POST',
    headers: { 'Idempotency-Key': input.idempotencyKey },
    body: failureNotificationDestinationCreateRequestSchema.parse(input.config),
    response: {
      kind: 'json',
      decode: (value) =>
        failureNotificationDestinationResponseSchema.parse(value),
    },
  });
}

export function appendFailureNotificationDestinationVersion(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{
    destinationId: string;
    expectedVersion: number;
    config: FailureNotificationDestinationConfig;
    idempotencyKey: string;
  }>,
): Promise<FailureNotificationDestinationResponse> {
  return apiClient.request({
    path: `${destinationsPath(workspaceId)}/${encodeURIComponent(input.destinationId)}/versions`,
    method: 'POST',
    headers: { 'Idempotency-Key': input.idempotencyKey },
    body: failureNotificationDestinationAppendVersionRequestSchema.parse({
      expectedVersion: input.expectedVersion,
      config: input.config,
    }),
    response: {
      kind: 'json',
      decode: (value) =>
        failureNotificationDestinationResponseSchema.parse(value),
    },
  });
}

export function setFailureNotificationDestinationStatus(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{
    destinationId: string;
    status: 'enabled' | 'disabled';
    idempotencyKey: string;
  }>,
): Promise<FailureNotificationDestinationResponse> {
  return apiClient.request({
    path: `${destinationsPath(workspaceId)}/${encodeURIComponent(input.destinationId)}/status`,
    method: 'PUT',
    headers: { 'Idempotency-Key': input.idempotencyKey },
    body: failureNotificationDestinationStatusRequestSchema.parse({
      status: input.status,
    }),
    response: {
      kind: 'json',
      decode: (value) =>
        failureNotificationDestinationResponseSchema.parse(value),
    },
  });
}

export type FailureNotificationDestinationList = Awaited<
  ReturnType<typeof getFailureNotificationDestinations>
>;
