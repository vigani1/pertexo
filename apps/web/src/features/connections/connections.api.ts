import {
  connectionCreateRequestSchema,
  connectionListResponseSchema,
  connectionRotateSecretRequestSchema,
  connectionResponseSchema,
  connectionTestRequestSchema,
  connectionTestResponseSchema,
  type ConnectionResponse,
  type ConnectionListResponse,
  type ConnectionTestResponse,
} from '@pertexo/contracts/schemas/connections';
import type { ApiClient } from '@/lib/api/client';

export function getConnectionsPage(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{ after?: string; signal?: AbortSignal }> = {},
): Promise<ConnectionListResponse> {
  const query = new URLSearchParams({ limit: '100' });
  if (input.after !== undefined) query.set('after', input.after);
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/connections?${query.toString()}`,
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

export function createSlackConnection(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{
    name: string;
    botToken: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }>,
): Promise<ConnectionResponse> {
  const body = connectionCreateRequestSchema.parse({
    providerKey: 'slack',
    name: input.name,
    credential: {
      schemaVersion: 1,
      type: 'slack_bot_token',
      botToken: input.botToken,
    },
  });
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/connections`,
    method: 'POST',
    body,
    headers: { 'Idempotency-Key': input.idempotencyKey },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    response: {
      kind: 'json',
      decode: (value) => connectionResponseSchema.parse(value),
    },
  });
}

export function testSlackConnection(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{
    connectionId: string;
    idempotencyKey: string;
  }>,
): Promise<ConnectionTestResponse> {
  const body = connectionTestRequestSchema.parse({ providerKey: 'slack' });
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/connections/${encodeURIComponent(input.connectionId)}/test`,
    method: 'POST',
    body,
    headers: { 'Idempotency-Key': input.idempotencyKey },
    response: {
      kind: 'json',
      decode: (value) => connectionTestResponseSchema.parse(value),
    },
  });
}

export function rotateSlackConnectionSecret(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{
    connectionId: string;
    expectedSecretVersionId: string;
    botToken: string;
    idempotencyKey: string;
  }>,
): Promise<ConnectionResponse> {
  const body = connectionRotateSecretRequestSchema.parse({
    expectedSecretVersionId: input.expectedSecretVersionId,
    credential: {
      schemaVersion: 1,
      type: 'slack_bot_token',
      botToken: input.botToken,
    },
  });
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/connections/${encodeURIComponent(input.connectionId)}/secret`,
    method: 'PUT',
    body,
    headers: { 'Idempotency-Key': input.idempotencyKey },
    response: {
      kind: 'json',
      decode: (value) => connectionResponseSchema.parse(value),
    },
  });
}

export function revokeConnection(
  apiClient: ApiClient,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionResponse> {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/connections/${encodeURIComponent(connectionId)}`,
    method: 'DELETE',
    response: {
      kind: 'json',
      decode: (value) => connectionResponseSchema.parse(value),
    },
  });
}
