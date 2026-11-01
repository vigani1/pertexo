import { createHash, createHmac } from 'node:crypto';

import { encodeStoredClientSecret } from '@pertexo/integrations/server';
import { canonicalJson } from '@pertexo/workflow-model';

import type {
  ConnectionRecord,
  ConnectionTestResult,
} from '@pertexo/core/connections';

import type {
  ActorContext,
  AuthorizedWorkspaceContext,
} from '../../authorization/index.js';
import {
  connectionResponseSchema,
  connectionListResponseSchema,
  type ConnectionListResponse,
  connectionTestResponseSchema,
  type ConnectionResponse,
  type ConnectionTestResponse,
} from '../types.js';

export type ConnectionCommandInput = Readonly<{
  actor: ActorContext;
  routeWorkspaceId: string;
  authorizedWorkspace?: AuthorizedWorkspaceContext;
  requestId?: string;
  traceId?: string;
  signal?: AbortSignal;
}>;

export const encryptionSignal = (input: ConnectionCommandInput): AbortSignal =>
  input.signal ?? AbortSignal.timeout(30_000);

export const encodeCredential = (
  credential: Readonly<{ type: string; clientSecret?: string }>,
): Uint8Array =>
  credential.type === 'oauth2' && credential.clientSecret !== undefined
    ? encodeStoredClientSecret(credential.clientSecret)
    : new TextEncoder().encode(JSON.stringify(credential));

export function hashRequest(
  secret: string,
  workspaceId: string,
  purpose: string,
  value: unknown,
): string {
  return createHmac('sha256', secret)
    .update(canonicalJson({ purpose, workspaceId, value }))
    .digest('hex');
}

export function connectionTestProviderKey(
  connectionId: string,
  idempotencyKey: string,
): string {
  return `pertexo-connection-test-v1-${createHash('sha256')
    .update(`${connectionId}\0${idempotencyKey}`)
    .digest('hex')}`;
}

/** An OAuth2 connection's grant, present exactly when its status says active. */
function oauth2Fields(
  record: ConnectionRecord,
  redirectUri: string | undefined,
) {
  if (record.oauth2 === undefined) return {};
  if (redirectUri === undefined)
    throw new Error('OAuth2 connection answered with no redirect URI');
  const { settings, grant } = record.oauth2;
  return {
    oauth2: { settings, redirectUri },
    ...(grant === null
      ? {}
      : {
          grant: {
            authorizedAt: grant.authorizedAt.toISOString(),
            accessTokenExpiresAt:
              grant.accessTokenExpiresAt?.toISOString() ?? null,
            renewable: grant.renewable,
          },
        }),
  };
}

export function toResponse(
  record: ConnectionRecord,
  oauth2RedirectUri?: string,
): ConnectionResponse {
  return connectionResponseSchema.parse({
    id: record.id,
    workspaceId: record.workspaceId,
    providerKey: record.providerKey,
    name: record.name,
    authType: record.authType,
    status: record.status,
    secretVersionId: record.currentSecretVersionId,
    health: {
      lastTestedAt: record.lastTestedAt?.toISOString() ?? null,
      lastHealthyAt: record.lastHealthyAt?.toISOString() ?? null,
      lastErrorCode: record.lastErrorCode,
      lastRunObservedAt: record.lastRunObservedAt?.toISOString() ?? null,
      lastHealthTransitionAt:
        record.lastHealthTransitionAt?.toISOString() ?? null,
      lastHealthTransitionSource: record.lastHealthTransitionSource ?? null,
    },
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    accessMode: record.accessMode,
    ...oauth2Fields(record, oauth2RedirectUri),
  });
}

export function toListResponse(
  records: readonly ConnectionRecord[],
  nextCursor: string | null,
  oauth2RedirectUri?: string,
): ConnectionListResponse {
  return connectionListResponseSchema.parse({
    items: records.map((record) => toResponse(record, oauth2RedirectUri)),
    nextCursor,
  });
}

export function toTestResponse(
  result: ConnectionTestResult,
  oauth2RedirectUri?: string,
): ConnectionTestResponse {
  return connectionTestResponseSchema.parse({
    connection: toResponse(result.connection, oauth2RedirectUri),
    outcome: result.outcome.ok
      ? {
          ok: true,
          httpStatus: result.outcome.httpStatus,
          errorCode: null,
        }
      : {
          ok: false,
          httpStatus: result.outcome.httpStatus,
          errorCode: result.outcome.errorCode,
        },
  });
}
