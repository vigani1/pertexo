import {
  connectionCreateRequestSchema,
  connectionListResponseSchema,
  connectionRotateSecretRequestSchema,
  connectionResponseSchema,
  connectionTestRequestSchema,
  connectionTestResponseSchema,
  connectionUsageResponseSchema,
  connectionLookupPath,
  connectionLookupResponseSchema,
  httpHeadersCredentialSchema,
  type ConnectionCreateRequest,
  type ConnectionListResponse,
  type ConnectionResponse,
  type ConnectionRotateSecretRequest,
  type ConnectionTestRequest,
  type ConnectionTestResponse,
  type ConnectionUsageResponse,
  type ConnectionLookupRequest,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { collectPages, searchParams } from '@/lib/api/pagination';

export type ConnectionCredential = ConnectionRotateSecretRequest['credential'];

function connectionsPath(workspaceId: string): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/connections`;
}

function connectionPath(
  workspaceId: string,
  connectionId: string,
): `/v1${string}` {
  return `${connectionsPath(workspaceId)}/${encodeURIComponent(connectionId)}`;
}

const decodeConnection = {
  kind: 'json',
  decode: (value: unknown) => connectionResponseSchema.parse(value),
} as const;

export function getConnectionUsagePage(
  apiClient: ApiClient,
  workspaceId: string,
  connectionId: string,
  input: Readonly<{ after?: string; signal?: AbortSignal }> = {},
): Promise<ConnectionUsageResponse> {
  const query = searchParams({ limit: '50', after: input.after });
  return apiClient.request({
    path: `${connectionPath(workspaceId, connectionId)}/usage?${query}`,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    response: {
      kind: 'json',
      decode: (value) => connectionUsageResponseSchema.parse(value),
    },
  });
}

export function getConnectionsPage(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{ after?: string; signal?: AbortSignal }> = {},
): Promise<ConnectionListResponse> {
  const query = new URLSearchParams({ limit: '100' });
  if (input.after !== undefined) query.set('after', input.after);
  return apiClient.request({
    path: `${connectionsPath(workspaceId)}?${query.toString()}`,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    response: {
      kind: 'json',
      decode: (value) => connectionListResponseSchema.parse(value),
    },
  });
}

export async function getAllConnections(
  apiClient: ApiClient,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<ConnectionListResponse> {
  const items = await collectPages(
    (after) =>
      getConnectionsPage(apiClient, workspaceId, {
        ...(after === undefined ? {} : { after }),
        ...(signal === undefined ? {} : { signal }),
      }),
    { read: 'Connection discovery', signal },
  );
  return { items: [...items], nextCursor: null };
}

export function getConnection(
  apiClient: ApiClient,
  workspaceId: string,
  connectionId: string,
  signal?: AbortSignal,
): Promise<ConnectionResponse> {
  return apiClient.request({
    path: connectionPath(workspaceId, connectionId),
    ...(signal === undefined ? {} : { signal }),
    response: decodeConnection,
  });
}

/** Creates any provider's connection; the credential never leaves this call. */
export function createConnection(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{
    request: ConnectionCreateRequest;
    idempotencyKey: string;
  }>,
): Promise<ConnectionResponse> {
  return apiClient.request({
    path: connectionsPath(workspaceId),
    method: 'POST',
    body: connectionCreateRequestSchema.parse({
      ...input.request,
      credential: credentialForWire(input.request.credential),
    }),
    headers: { 'Idempotency-Key': input.idempotencyKey },
    response: decodeConnection,
  });
}

export function testConnection(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{
    connectionId: string;
    request: ConnectionTestRequest;
    idempotencyKey: string;
  }>,
): Promise<ConnectionTestResponse> {
  return apiClient.request({
    path: `${connectionPath(workspaceId, input.connectionId)}/test`,
    method: 'POST',
    body: connectionTestRequestSchema.parse(input.request),
    headers: { 'Idempotency-Key': input.idempotencyKey },
    response: {
      kind: 'json',
      decode: (value) => connectionTestResponseSchema.parse(value),
    },
  });
}

export function rotateConnectionSecret(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{
    connectionId: string;
    expectedSecretVersionId: string;
    credential: ConnectionCredential;
    idempotencyKey: string;
  }>,
): Promise<ConnectionResponse> {
  return apiClient.request({
    path: `${connectionPath(workspaceId, input.connectionId)}/secret`,
    method: 'PUT',
    body: connectionRotateSecretRequestSchema.parse({
      expectedSecretVersionId: input.expectedSecretVersionId,
      credential: credentialForWire(input.credential),
    }),
    headers: { 'Idempotency-Key': input.idempotencyKey },
    response: decodeConnection,
  });
}

export function lookupConnectionOptions(
  apiClient: ApiClient,
  workspaceId: string,
  connectionId: string,
  body: ConnectionLookupRequest,
  signal: AbortSignal,
) {
  return apiClient.request({
    path: connectionLookupPath(workspaceId, connectionId),
    method: 'POST',
    body,
    signal,
    response: {
      kind: 'json',
      decode: (value) => connectionLookupResponseSchema.parse(value),
    },
  });
}

export function revokeConnection(
  apiClient: ApiClient,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionResponse> {
  return apiClient.request({
    path: connectionPath(workspaceId, connectionId),
    method: 'DELETE',
    response: decodeConnection,
  });
}

function credentialForWire(
  credential: ConnectionCredential,
): ConnectionCredential {
  return credential.type === 'http_headers'
    ? httpHeadersCredentialSchema.parse(credential)
    : credential;
}
