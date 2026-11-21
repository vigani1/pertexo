import type {
  SecretConnectionAuthType,
  ConnectionStatus,
  ConnectionTestOutcome,
} from '@pertexo/workflow-model';
import type { connections } from '@pertexo/database/schema';

export type { SealedConnectionSecret as SealedConnectionSecretRecord } from '@pertexo/secrets/server';
import type { SealedConnectionSecret as SealedConnectionSecretRecord } from '@pertexo/secrets/server';

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
  | Readonly<{ authType: SecretConnectionAuthType; oauth2Settings?: never }>
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
    | Readonly<{
        expectedAuthType?: SecretConnectionAuthType;
        oauth2Settings?: never;
      }>
    | Readonly<{ expectedAuthType: 'oauth2'; oauth2Settings: unknown }>
  ) &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    secretVersionId: string;
    expectedProviderKey?: string;
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
  expectedAuthType: string;
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
