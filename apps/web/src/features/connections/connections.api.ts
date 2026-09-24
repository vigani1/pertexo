import {
  connectionCreateRequestSchema,
  connectionListResponseSchema,
  connectionRotateSecretRequestSchema,
  connectionResponseSchema,
  connectionTestRequestSchema,
  connectionTestResponseSchema,
  type ConnectionCreateRequest,
  type ConnectionListResponse,
  type ConnectionResponse,
  type ConnectionRotateSecretRequest,
  type ConnectionTestRequest,
  type ConnectionTestResponse,
} from '@pertexo/contracts/schemas/connections';
import type { ApiClient } from '@/lib/api/client';

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
  const items: ConnectionListResponse['items'][number][] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 40; page += 1) {
    const response = await getConnectionsPage(apiClient, workspaceId, {
      ...(after === undefined ? {} : { after }),
      ...(signal === undefined ? {} : { signal }),
    });
    items.push(...response.items);
    if (response.nextCursor === null) return { items, nextCursor: null };
    if (seen.has(response.nextCursor))
      throw new Error('Connection pagination repeated a cursor.');
    seen.add(response.nextCursor);
    after = response.nextCursor;
  }
  throw new Error('Connection discovery exceeded its bounded page limit.');
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
    body: connectionCreateRequestSchema.parse(input.request),
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
      credential: input.credential,
    }),
    headers: { 'Idempotency-Key': input.idempotencyKey },
    response: decodeConnection,
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
