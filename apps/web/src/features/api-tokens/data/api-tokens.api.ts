import {
  apiTokenCreateResponseSchema,
  apiTokenListResponseSchema,
  apiTokenRevokeResponseSchema,
  type ApiTokenCreateRequest,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';

function path(workspaceId: string): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/api-tokens`;
}

export function getApiTokensPage(
  apiClient: ApiClient,
  workspaceId: string,
  after: string | null,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({ limit: '25' });
  if (after !== null) query.set('after', after);
  return apiClient.request({
    path: `${path(workspaceId)}?${query}`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => apiTokenListResponseSchema.parse(value),
    },
  });
}

/** The caller owns the one-time response; never pass this through a mutation cache. */
export function createApiToken({
  apiClient,
  workspaceId,
  body,
  idempotencyKey,
  signal,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  body: ApiTokenCreateRequest;
  idempotencyKey: string;
  signal: AbortSignal;
}>) {
  return apiClient.request({
    path: path(workspaceId),
    method: 'POST',
    body,
    signal,
    headers: { 'Idempotency-Key': idempotencyKey },
    response: {
      kind: 'json',
      decode: (value) => apiTokenCreateResponseSchema.parse(value),
    },
  });
}

export function revokeApiToken(
  apiClient: ApiClient,
  workspaceId: string,
  tokenId: string,
  idempotencyKey: string,
) {
  return apiClient.request({
    path: `${path(workspaceId)}/${encodeURIComponent(tokenId)}/revoke`,
    method: 'POST',
    body: {},
    headers: { 'Idempotency-Key': idempotencyKey },
    response: {
      kind: 'json',
      decode: (value) => apiTokenRevokeResponseSchema.parse(value),
    },
  });
}
