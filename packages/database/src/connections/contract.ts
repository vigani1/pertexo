import type { z } from 'zod';

import type { sealedSecretSchema } from './admission.js';

export const CONNECTION_STATUS = {
  active: 'active',
  reauthorizationRequired: 'reauthorization_required',
  revoked: 'revoked',
} as const;

export type ConnectionStatus =
  (typeof CONNECTION_STATUS)[keyof typeof CONNECTION_STATUS];

export const CONNECTION_AUTH_TYPE = {
  signingKey: 'hmac_key',
  httpHeaders: 'http_headers',
  slackBotToken: 'slack_bot_token',
  resendApiKey: 'resend_api_key',
} as const;

export type ConnectionAuthType =
  (typeof CONNECTION_AUTH_TYPE)[keyof typeof CONNECTION_AUTH_TYPE];

export const CONNECTION_EVENT_TYPE = {
  created: 'connection.created',
  secretRotated: 'connection.secret_rotated',
  testSucceeded: 'connection.test_succeeded',
  testFailed: 'connection.test_failed',
  reauthorizationRequired: 'connection.reauthorization_required',
  revoked: 'connection.revoked',
  credentialAccessed: 'connection.credential_accessed',
} as const;

export type SealedConnectionSecretRecord = Readonly<
  z.output<typeof sealedSecretSchema>
>;

export type ConnectionRecord = Readonly<{
  id: string;
  workspaceId: string;
  providerKey: string;
  name: string;
  authType: ConnectionAuthType;
  status: ConnectionStatus;
  currentSecretVersionId: string;
  lastTestedAt: Date | null;
  lastHealthyAt: Date | null;
  lastErrorCode: string | null;
  lastRunObservedAt?: Date | null;
  lastHealthTransitionAt?: Date | null;
  lastHealthTransitionSource?: 'run' | 'test' | 'rotation' | 'revoke' | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  accessMode: 'workspace' | 'restricted';
}>;

export type ListConnectionsInput = Readonly<{
  workspaceId: string;
  actorId: string;
  limit?: number;
  after?: Readonly<{
    status: ConnectionStatus;
    createdAt: string;
    id: string;
  }>;
}>;

export type ConnectionPage = Readonly<{
  items: readonly ConnectionRecord[];
  nextCursor?: Readonly<{
    status: ConnectionStatus;
    createdAt: string;
    id: string;
  }>;
}>;

export type ReadConnectionInput = Readonly<{
  workspaceId: string;
  actorId: string;
  connectionId: string;
}>;

export type ResolvedConnectionSecretRecord = Readonly<{
  connection: ConnectionRecord;
  secretVersionId: string;
  sealed: SealedConnectionSecretRecord;
}>;

export type RequestMetadata = Readonly<{
  requestId?: string;
  traceId?: string;
}>;

export type CreateConnectionInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    secretVersionId: string;
    providerKey: string;
    name: string;
    authType: ConnectionAuthType;
    sealed: SealedConnectionSecretRecord;
    idempotencyKey: string;
    requestHash: string;
  }>;

export type FindConnectionCreateReplayInput = Readonly<{
  workspaceId: string;
  actorId: string;
  idempotencyKey: string;
  requestHash: string;
}>;

export type FindConnectionRotateReplayInput = Readonly<{
  workspaceId: string;
  actorId: string;
  connectionId: string;
  idempotencyKey: string;
  requestHash: string;
}>;

export type RotateConnectionSecretInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    secretVersionId: string;
    expectedCurrentSecretVersionId: string;
    expectedAuthType?: ConnectionAuthType;
    sealed: SealedConnectionSecretRecord;
    idempotencyKey: string;
    requestHash: string;
  }>;

export type RevokeConnectionInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
  }>;

export type ResolveConnectionSecretInput = Readonly<{
  workspaceId: string;
  connectionId: string;
  expectedProviderKey: string;
  workerId: string;
  purpose: string;
  signal?: AbortSignal;
  traceId?: string;
}>;

export type AssertConnectionSecretCurrentInput = Readonly<{
  workspaceId: string;
  connectionId: string;
  expectedProviderKey: string;
  expectedAuthType: ConnectionAuthType;
  secretVersionId: string;
  signal?: AbortSignal;
}>;

export type ConnectionTestOutcome =
  | Readonly<{ ok: true; httpStatus: number }>
  | Readonly<{
      ok: false;
      httpStatus: number | null;
      errorCode: string;
      reauthorizationRequired: boolean;
    }>;

export type ConnectionTestResult = Readonly<{
  connection: ConnectionRecord;
  outcome: ConnectionTestOutcome;
}>;

export type StartConnectionTestInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    expectedProviderKey: string;
    idempotencyKey: string;
    requestHash: string;
    dispatchToken: string;
  }>;

export type StartConnectionTestResult =
  | Readonly<{ kind: 'replay'; result: ConnectionTestResult }>
  | Readonly<{
      kind: 'dispatch';
      dispatchToken: string;
    }>;

export type ResolveConnectionTestSecretInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    expectedProviderKey: string;
    idempotencyKey: string;
    requestHash: string;
    dispatchToken: string;
  }>;

export type MarkConnectionTestDispatchedInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    idempotencyKey: string;
    requestHash: string;
    dispatchToken: string;
    secretVersionId: string;
  }>;

export type CompleteConnectionTestInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    idempotencyKey: string;
    requestHash: string;
    dispatchToken: string;
    secretVersionId: string;
    outcome: ConnectionTestOutcome;
  }>;

export type AbandonConnectionTestInput = Readonly<{
  workspaceId: string;
  actorId: string;
  connectionId: string;
  idempotencyKey: string;
  requestHash: string;
  dispatchToken: string;
}>;

export interface ConnectionDatabase {
  listConnections(input: ListConnectionsInput): Promise<ConnectionPage>;
  readConnection(input: ReadConnectionInput): Promise<ConnectionRecord | null>;
  createConnection(input: CreateConnectionInput): Promise<ConnectionRecord>;
  findConnectionCreateReplay(
    input: FindConnectionCreateReplayInput,
  ): Promise<ConnectionRecord | null>;
  findConnectionRotateReplay(
    input: FindConnectionRotateReplayInput,
  ): Promise<ConnectionRecord | null>;
  getConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<ConnectionRecord | null>;
  rotateConnectionSecret(
    input: RotateConnectionSecretInput,
  ): Promise<ConnectionRecord>;
  revokeConnection(input: RevokeConnectionInput): Promise<ConnectionRecord>;
  resolveConnectionSecret(
    input: ResolveConnectionSecretInput,
  ): Promise<ResolvedConnectionSecretRecord>;
  assertConnectionSecretCurrent(
    input: AssertConnectionSecretCurrentInput,
  ): Promise<void>;
  startConnectionTest(
    input: StartConnectionTestInput,
  ): Promise<StartConnectionTestResult>;
  resolveConnectionTestSecret(
    input: ResolveConnectionTestSecretInput,
  ): Promise<ResolvedConnectionSecretRecord>;
  markConnectionTestDispatched(
    input: MarkConnectionTestDispatchedInput,
  ): Promise<void>;
  completeConnectionTest(
    input: CompleteConnectionTestInput,
  ): Promise<ConnectionTestResult>;
  abandonConnectionTest(input: AbandonConnectionTestInput): Promise<void>;
  close(): Promise<void>;
}

/**
 * API connection commands and their idempotency lookups.
 *
 * This view deliberately excludes secret resolution and worker-only health
 * operations.  The implementation remains shared by the role-specific
 * factories below, but callers receive only the behavior they own.
 */
export type ConnectionManagementDatabase = Pick<
  ConnectionDatabase,
  | 'createConnection'
  | 'findConnectionCreateReplay'
  | 'findConnectionRotateReplay'
  | 'rotateConnectionSecret'
  | 'revokeConnection'
>;

/** Safe metadata reads for authenticated API consumers. */
export type ConnectionReadDatabase = Pick<
  ConnectionDatabase,
  'listConnections' | 'readConnection'
>;

/** API-owned connection-test state transitions. */
export type ConnectionTestDatabase = Pick<
  ConnectionDatabase,
  | 'startConnectionTest'
  | 'resolveConnectionTestSecret'
  | 'markConnectionTestDispatched'
  | 'completeConnectionTest'
  | 'abandonConnectionTest'
>;

/** The only connection behavior required by a worker node executor. */
export type ConnectionResolutionDatabase = Pick<
  ConnectionDatabase,
  'assertConnectionSecretCurrent' | 'resolveConnectionSecret'
>;

export class ConnectionNotFoundError extends Error {
  public override readonly name = 'ConnectionNotFoundError';
}

export class ConnectionConflictError extends Error {
  public override readonly name = 'ConnectionConflictError';
}

export class ConnectionIdempotencyConflictError extends Error {
  public override readonly name = 'ConnectionIdempotencyConflictError';
}

export class ConnectionUnavailableError extends Error {
  public override readonly name = 'ConnectionUnavailableError';
}

export class ConnectionSharingRevisionConflictError extends Error {
  override readonly name = 'ConnectionSharingRevisionConflictError';
  constructor() {
    super('Connection sharing changed');
  }
}

export class ConnectionSecretVersionConflictError extends Error {
  public override readonly name = 'ConnectionSecretVersionConflictError';
}

export class ConnectionTestInProgressError extends Error {
  public override readonly name = 'ConnectionTestInProgressError';
}
