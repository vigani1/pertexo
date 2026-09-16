import {
  ConnectionNotFoundError,
  generatePersistedId,
} from '@pertexo/database/api';

import type { WorkspaceAuthorizationSource } from '../workspaces/index.js';
import { authorizeConnectionOperation } from './authorization.js';
import type {
  ConnectionCommandPersistence,
  ConnectionReadPersistence,
  ConnectionSecretEncryptionPort,
} from './ports.js';
import { decodeConnectionCursor, encodeConnectionCursor } from './cursor.js';
import {
  encodeCredential,
  encryptionSignal,
  hashRequest,
  toListResponse,
  toResponse,
  type ConnectionCommandInput,
} from './use-case-support.js';
import {
  CONNECTION_OPERATION,
  NOOP_CONNECTION_TELEMETRY,
  type ConnectionTelemetry,
} from './telemetry.js';
import {
  connectionCreateRequestSchema,
  connectionRotateSecretRequestSchema,
  type ConnectionResponse,
} from './types.js';

export { TestConnectionUseCase } from './connection-testing.js';
export type { TestConnectionCommand } from './connection-testing.js';

export type CreateConnectionCommand = ConnectionCommandInput &
  Readonly<{
    request: unknown;
    idempotencyKey: string;
  }>;

export type RotateConnectionSecretCommand = ConnectionCommandInput &
  Readonly<{
    connectionId: string;
    request: unknown;
    idempotencyKey: string;
  }>;

export type RevokeConnectionCommand = ConnectionCommandInput &
  Readonly<{ connectionId: string }>;

export type ListConnectionsQuery = ConnectionCommandInput &
  Readonly<{ limit?: number; after?: string }>;

export type GetConnectionQuery = ConnectionCommandInput &
  Readonly<{ connectionId: string }>;

export class ListConnectionsUseCase {
  public constructor(
    private readonly persistence: ConnectionReadPersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: ConnectionTelemetry = NOOP_CONNECTION_TELEMETRY,
  ) {}

  public execute(input: ListConnectionsQuery) {
    return this.telemetry.measure(CONNECTION_OPERATION.list, async () => {
      await authorizeConnectionOperation(
        input,
        this.authorization,
        'connection:read',
      );
      const page = await this.persistence.listConnections({
        workspaceId: input.routeWorkspaceId,
        actorId: input.actor.actorId,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.after === undefined
          ? {}
          : { after: decodeConnectionCursor(input.after) }),
      });
      return toListResponse(
        page.items,
        page.nextCursor === undefined
          ? null
          : encodeConnectionCursor(page.nextCursor),
      );
    });
  }
}

export class GetConnectionUseCase {
  public constructor(
    private readonly persistence: ConnectionReadPersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: ConnectionTelemetry = NOOP_CONNECTION_TELEMETRY,
  ) {}

  public execute(input: GetConnectionQuery) {
    return this.telemetry.measure(CONNECTION_OPERATION.read, async () => {
      await authorizeConnectionOperation(
        input,
        this.authorization,
        'connection:read',
      );
      const connection = await this.persistence.readConnection({
        workspaceId: input.routeWorkspaceId,
        actorId: input.actor.actorId,
        connectionId: input.connectionId,
      });
      if (connection === null)
        throw new ConnectionNotFoundError('Connection is not visible');
      return toResponse(connection);
    });
  }
}

export class CreateConnectionUseCase {
  public constructor(
    private readonly persistence: ConnectionCommandPersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly encryption: Pick<ConnectionSecretEncryptionPort, 'seal'>,
    private readonly telemetry: ConnectionTelemetry = NOOP_CONNECTION_TELEMETRY,
  ) {}

  public execute(input: CreateConnectionCommand): Promise<ConnectionResponse> {
    return this.telemetry.measure(CONNECTION_OPERATION.create, async () => {
      await authorizeConnectionOperation(input, this.authorization);
      const request = connectionCreateRequestSchema.parse(input.request);
      const requestHash = hashRequest(request);
      const replay = await this.persistence.findConnectionCreateReplay({
        workspaceId: input.routeWorkspaceId,
        actorId: input.actor.actorId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
      });
      if (replay !== null) return toResponse(replay);
      const connectionId = generatePersistedId();
      const secretVersionId = generatePersistedId();
      const plaintext = encodeCredential(request.credential);
      try {
        const sealed = await this.encryption.seal(
          plaintext,
          {
            workspaceId: input.routeWorkspaceId,
            connectionId,
            secretVersionId,
          },
          encryptionSignal(input),
        );
        input.signal?.throwIfAborted();
        return toResponse(
          await this.persistence.createConnection({
            workspaceId: input.routeWorkspaceId,
            actorId: input.actor.actorId,
            connectionId,
            secretVersionId,
            providerKey: request.providerKey,
            name: request.name,
            authType: request.credential.type,
            sealed,
            idempotencyKey: input.idempotencyKey,
            requestHash,
            ...(input.requestId === undefined
              ? {}
              : { requestId: input.requestId }),
            ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
          }),
        );
      } finally {
        plaintext.fill(0);
      }
    });
  }
}

export class RotateConnectionSecretUseCase {
  public constructor(
    private readonly persistence: ConnectionCommandPersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly encryption: Pick<ConnectionSecretEncryptionPort, 'seal'>,
    private readonly telemetry: ConnectionTelemetry = NOOP_CONNECTION_TELEMETRY,
  ) {}

  public execute(
    input: RotateConnectionSecretCommand,
  ): Promise<ConnectionResponse> {
    return this.telemetry.measure(CONNECTION_OPERATION.rotate, async () => {
      await authorizeConnectionOperation(input, this.authorization);
      const request = connectionRotateSecretRequestSchema.parse(input.request);
      const secretVersionId = generatePersistedId();
      const requestHash = hashRequest({
        connectionId: input.connectionId,
        ...request,
      });
      const replay = await this.persistence.findConnectionRotateReplay({
        workspaceId: input.routeWorkspaceId,
        actorId: input.actor.actorId,
        connectionId: input.connectionId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
      });
      if (replay !== null) return toResponse(replay);
      const plaintext = encodeCredential(request.credential);
      try {
        const sealed = await this.encryption.seal(
          plaintext,
          {
            workspaceId: input.routeWorkspaceId,
            connectionId: input.connectionId,
            secretVersionId,
          },
          encryptionSignal(input),
        );
        input.signal?.throwIfAborted();
        return toResponse(
          await this.persistence.rotateConnectionSecret({
            workspaceId: input.routeWorkspaceId,
            actorId: input.actor.actorId,
            connectionId: input.connectionId,
            secretVersionId,
            expectedCurrentSecretVersionId: request.expectedSecretVersionId,
            expectedAuthType: request.credential.type,
            sealed,
            idempotencyKey: input.idempotencyKey,
            requestHash,
            ...(input.requestId === undefined
              ? {}
              : { requestId: input.requestId }),
            ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
          }),
        );
      } finally {
        plaintext.fill(0);
      }
    });
  }
}

export class RevokeConnectionUseCase {
  public constructor(
    private readonly persistence: ConnectionCommandPersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: ConnectionTelemetry = NOOP_CONNECTION_TELEMETRY,
  ) {}

  public execute(input: RevokeConnectionCommand): Promise<ConnectionResponse> {
    return this.telemetry.measure(CONNECTION_OPERATION.revoke, async () => {
      await authorizeConnectionOperation(input, this.authorization);
      input.signal?.throwIfAborted();
      return toResponse(
        await this.persistence.revokeConnection({
          workspaceId: input.routeWorkspaceId,
          actorId: input.actor.actorId,
          connectionId: input.connectionId,
          ...(input.requestId === undefined
            ? {}
            : { requestId: input.requestId }),
          ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        }),
      );
    });
  }
}
