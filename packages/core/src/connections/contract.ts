import type {
  ConnectionAuthType,
  ConnectionStatus,
  ConnectionTestOutcome,
} from '@pertexo/workflow-model';
import type {
  connections,
  connectionSecretVersions,
} from '@pertexo/database/schema';

export {
  CONNECTION_AUTH_TYPE,
  CONNECTION_EVENT_TYPE,
  CONNECTION_STATUS,
} from '@pertexo/workflow-model';
export type {
  ConnectionAuthType,
  ConnectionStatus,
  ConnectionTestOutcome,
} from '@pertexo/workflow-model';

export type SealedConnectionSecretRecord = Readonly<
  Pick<
    typeof connectionSecretVersions.$inferSelect,
    'kmsKeyReference' | 'encryptedDataKey' | 'ciphertext' | 'nonce'
  > & { tag: (typeof connectionSecretVersions.$inferSelect)['authTag'] }
>;

export type ConnectionRecord = Readonly<
  Omit<
    typeof connections.$inferSelect,
    | 'sharingRevision'
    | 'healthRevision'
    | 'lastRunObservedAt'
    | 'lastHealthTransitionAt'
    | 'lastHealthTransitionSource'
  > &
    Partial<
      Pick<
        typeof connections.$inferSelect,
        | 'lastRunObservedAt'
        | 'lastHealthTransitionAt'
        | 'lastHealthTransitionSource'
      >
    > & { oauth2?: OAuth2ConnectionFacts }
>;

/** Read beside the connection, so its status and grant can't disagree. */
export type OAuth2ConnectionFacts = Readonly<{
  settings: unknown;
  grant: Readonly<{
    authorizedAt: Date;
    accessTokenExpiresAt: Date | null;
    renewable: boolean;
  }> | null;
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

/** Only an OAuth2 connection has settings, and it always has them. */
type ConnectionAuthChoice =
  | Readonly<{ authType: Exclude<ConnectionAuthType, 'oauth2'> }>
  | Readonly<{ authType: 'oauth2'; oauth2Settings: unknown }>;

export type CreateConnectionInput = RequestMetadata &
  ConnectionAuthChoice &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    secretVersionId: string;
    providerKey: string;
    name: string;
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
  (
    | Readonly<{ expectedAuthType?: Exclude<ConnectionAuthType, 'oauth2'> }>
    | Readonly<{ expectedAuthType: 'oauth2'; oauth2Settings: unknown }>
  ) &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    secretVersionId: string;
    expectedCurrentSecretVersionId: string;
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

/** A stored share list is longer than the write path can ever make it. */
export class ConnectionSharingCorruptError extends Error {
  public override readonly name = 'ConnectionSharingCorruptError';
  public constructor() {
    super('Connection shares exceed the supported bound');
  }
}

export class ConnectionIdempotencyConflictError extends Error {
  public override readonly name = 'ConnectionIdempotencyConflictError';
}

export class ConnectionUnavailableError extends Error {
  public override readonly name = 'ConnectionUnavailableError';
}

/** An OAuth2 connection with no usable grant: it says so rather than just being unavailable. */
export class ConnectionOAuth2NotConnectedError extends ConnectionUnavailableError {}

/** Revoked for good: it can't be reconnected, so a step needs another connection. */
export class ConnectionOAuth2RevokedError extends ConnectionUnavailableError {}

export class ConnectionSharingRevisionConflictError extends Error {
  override readonly name = 'ConnectionSharingRevisionConflictError';
  constructor() {
    super('Connection sharing changed');
  }
}

export class ConnectionSecretVersionConflictError extends Error {
  public override readonly name = 'ConnectionSecretVersionConflictError';
}

/** OAuth2 consent was asked of a connection that doesn't use it. */
export class ConnectionNotOAuth2Error extends Error {
  public override readonly name = 'ConnectionNotOAuth2Error';
}

export class ConnectionTestInProgressError extends Error {
  public override readonly name = 'ConnectionTestInProgressError';
}
