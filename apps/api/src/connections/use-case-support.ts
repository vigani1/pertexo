import { createHash } from 'node:crypto';

import type {
  ConnectionRecord,
  ConnectionTestResult,
} from '@pertexo/database/api';

import type {
  ActorContext,
  AuthorizedWorkspaceContext,
} from '../workspaces/index.js';
import {
  connectionResponseSchema,
  connectionTestResponseSchema,
  type ConnectionResponse,
  type ConnectionTestResponse,
} from './types.js';

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

export const encodeCredential = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

export function hashRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function connectionTestProviderKey(
  connectionId: string,
  idempotencyKey: string,
): string {
  return `pertexo-connection-test-v1-${createHash('sha256')
    .update(`${connectionId}\0${idempotencyKey}`)
    .digest('hex')}`;
}

export function toResponse(record: ConnectionRecord): ConnectionResponse {
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
    },
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

export function toTestResponse(
  result: ConnectionTestResult,
): ConnectionTestResponse {
  return connectionTestResponseSchema.parse({
    connection: toResponse(result.connection),
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
