import { createHash, randomUUID } from 'node:crypto';

import type { ConnectionRecord } from '@pertexo/database';

import { authorizeWorkspace } from '../workspaces/index.js';
import type { ActorContext } from '../workspaces/index.js';
import type {
  ConnectionPersistence,
  ConnectionSecretEncryptionPort,
} from './ports.js';
import {
  CONNECTION_OPERATION,
  NOOP_CONNECTION_TELEMETRY,
  type ConnectionTelemetry,
} from './telemetry.js';
import {
  connectionCreateRequestSchema,
  connectionResponseSchema,
  connectionRotateSecretRequestSchema,
  type ConnectionResponse,
} from './types.js';

type ConnectionCommandInput = Readonly<{
  actor: ActorContext;
  routeWorkspaceId: string;
  requestId?: string;
  traceId?: string;
}>;

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

type Authorization = Parameters<typeof authorizeWorkspace>[0]['access'];

export class CreateConnectionUseCase {
  public constructor(
    private readonly persistence: ConnectionPersistence,
    private readonly authorization: Authorization,
    private readonly encryption: ConnectionSecretEncryptionPort,
    private readonly telemetry: ConnectionTelemetry = NOOP_CONNECTION_TELEMETRY,
  ) {}

  public execute(input: CreateConnectionCommand): Promise<ConnectionResponse> {
    return this.telemetry.measure(CONNECTION_OPERATION.create, async () => {
      await authorize(input, this.authorization);
      const request = connectionCreateRequestSchema.parse(input.request);
      const requestHash = hashRequest(request);
      const replay = await this.persistence.findConnectionCreateReplay({
        workspaceId: input.routeWorkspaceId,
        actorId: input.actor.actorId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
      });
      if (replay !== null) return toResponse(replay);
      const connectionId = randomUUID();
      const secretVersionId = randomUUID();
      const plaintext = encodeCredential(request.credential);
      try {
        const sealed = await this.encryption.seal(plaintext, {
          workspaceId: input.routeWorkspaceId,
          connectionId,
          secretVersionId,
        });
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
    private readonly persistence: ConnectionPersistence,
    private readonly authorization: Authorization,
    private readonly encryption: ConnectionSecretEncryptionPort,
    private readonly telemetry: ConnectionTelemetry = NOOP_CONNECTION_TELEMETRY,
  ) {}

  public execute(
    input: RotateConnectionSecretCommand,
  ): Promise<ConnectionResponse> {
    return this.telemetry.measure(CONNECTION_OPERATION.rotate, async () => {
      await authorize(input, this.authorization);
      const request = connectionRotateSecretRequestSchema.parse(input.request);
      const secretVersionId = randomUUID();
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
        const sealed = await this.encryption.seal(plaintext, {
          workspaceId: input.routeWorkspaceId,
          connectionId: input.connectionId,
          secretVersionId,
        });
        return toResponse(
          await this.persistence.rotateConnectionSecret({
            workspaceId: input.routeWorkspaceId,
            actorId: input.actor.actorId,
            connectionId: input.connectionId,
            secretVersionId,
            expectedCurrentSecretVersionId: request.expectedSecretVersionId,
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
    private readonly persistence: ConnectionPersistence,
    private readonly authorization: Authorization,
    private readonly telemetry: ConnectionTelemetry = NOOP_CONNECTION_TELEMETRY,
  ) {}

  public execute(input: RevokeConnectionCommand): Promise<ConnectionResponse> {
    return this.telemetry.measure(CONNECTION_OPERATION.revoke, async () => {
      await authorize(input, this.authorization);
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

async function authorize(
  input: ConnectionCommandInput,
  access: Authorization,
): Promise<void> {
  await authorizeWorkspace({
    actor: input.actor,
    routeWorkspaceId: input.routeWorkspaceId,
    capability: 'connection:manage',
    access,
    disclosure: 'not_found',
    allowedWorkspaceStatuses: ['active'],
  });
}

function encodeCredential(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function hashRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function toResponse(record: ConnectionRecord): ConnectionResponse {
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
