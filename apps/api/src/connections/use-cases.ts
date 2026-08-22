import { createHash, randomUUID } from 'node:crypto';

import type {
  ConnectionRecord,
  ConnectionTestOutcome,
  ConnectionTestResult,
} from '@pertexo/database';
import {
  ConnectionSecretEncryptionError,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
} from '@pertexo/integrations/server';

import { authorizeWorkspace } from '../workspaces/index.js';
import type { ActorContext } from '../workspaces/index.js';
import type {
  ConnectionCommandPersistence,
  ConnectionHttpClient,
  ConnectionTestPersistence,
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
  connectionTestRequestSchema,
  connectionTestResponseSchema,
  httpHeadersCredentialSchema,
  type ConnectionResponse,
  type ConnectionTestResponse,
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

export type TestConnectionCommand = ConnectionCommandInput &
  Readonly<{
    connectionId: string;
    request: unknown;
    idempotencyKey: string;
  }>;

type Authorization = Parameters<typeof authorizeWorkspace>[0]['access'];

export class CreateConnectionUseCase {
  public constructor(
    private readonly persistence: ConnectionCommandPersistence,
    private readonly authorization: Authorization,
    private readonly encryption: Pick<ConnectionSecretEncryptionPort, 'seal'>,
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
    private readonly persistence: ConnectionCommandPersistence,
    private readonly authorization: Authorization,
    private readonly encryption: Pick<ConnectionSecretEncryptionPort, 'seal'>,
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
    private readonly persistence: ConnectionCommandPersistence,
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

export class TestConnectionUseCase {
  public constructor(
    private readonly persistence: ConnectionTestPersistence,
    private readonly authorization: Authorization,
    private readonly encryption: ConnectionSecretEncryptionPort,
    private readonly httpClient: ConnectionHttpClient,
    private readonly telemetry: ConnectionTelemetry = NOOP_CONNECTION_TELEMETRY,
  ) {}

  public execute(
    input: TestConnectionCommand,
  ): Promise<ConnectionTestResponse> {
    return this.telemetry.measure(CONNECTION_OPERATION.test, async () => {
      await authorize(input, this.authorization, 'connection:use');
      const request = connectionTestRequestSchema.parse(input.request);
      const requestHash = hashRequest({
        connectionId: input.connectionId,
        url: request.url,
      });
      const dispatchToken = randomUUID();
      const common = Object.freeze({
        workspaceId: input.routeWorkspaceId,
        actorId: input.actor.actorId,
        connectionId: input.connectionId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        dispatchToken,
        ...(input.requestId === undefined
          ? {}
          : { requestId: input.requestId }),
        ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      });
      const started = await this.persistence.startConnectionTest({
        ...common,
        expectedProviderKey: 'http',
      });
      if (started.kind === 'replay') return toTestResponse(started.result);

      let plaintext: Uint8Array | undefined;
      try {
        await authorize(input, this.authorization, 'connection:use');
        const resolved = await this.persistence.resolveConnectionTestSecret({
          ...common,
          expectedProviderKey: 'http',
        });
        plaintext = await this.encryption.open(resolved.sealed, {
          workspaceId: input.routeWorkspaceId,
          connectionId: input.connectionId,
          secretVersionId: resolved.secretVersionId,
        });
        const credential = decodeCredential(plaintext);
        const sensitiveValues = Object.values(credential.headers);
        try {
          const response = await this.httpClient.execute({
            url: request.url,
            method: 'GET',
            headers: credential.headers,
            timeoutMillis: 15_000,
            maxRedirects: 3,
            maxResponseBytes: 65_536,
            sensitiveValues,
            beforeDispatch: () =>
              this.persistence.markConnectionTestDispatched({
                ...common,
                secretVersionId: resolved.secretVersionId,
              }),
          });
          try {
            return toTestResponse(
              await this.persistence.completeConnectionTest({
                ...common,
                secretVersionId: resolved.secretVersionId,
                outcome: responseOutcome(response.status),
              }),
            );
          } finally {
            response.body.fill(0);
          }
        } catch (error: unknown) {
          if (!(error instanceof SecureHttpError)) throw error;
          if (error.code === SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed)
            throw error;
          return toTestResponse(
            await this.persistence.completeConnectionTest({
              ...common,
              secretVersionId: resolved.secretVersionId,
              outcome: secureErrorOutcome(error),
            }),
          );
        }
      } catch (error: unknown) {
        await this.persistence
          .abandonConnectionTest(common)
          .catch(() => undefined);
        throw error;
      } finally {
        plaintext?.fill(0);
      }
    });
  }
}

async function authorize(
  input: ConnectionCommandInput,
  access: Authorization,
  capability: 'connection:manage' | 'connection:use' = 'connection:manage',
): Promise<void> {
  await authorizeWorkspace({
    actor: input.actor,
    routeWorkspaceId: input.routeWorkspaceId,
    capability,
    access,
    disclosure: 'not_found',
    allowedWorkspaceStatuses: ['active'],
  });
}

function decodeCredential(plaintext: Uint8Array) {
  try {
    const serialized = new TextDecoder('utf-8', { fatal: true }).decode(
      plaintext,
    );
    return httpHeadersCredentialSchema.parse(JSON.parse(serialized));
  } catch {
    throw new ConnectionSecretEncryptionError();
  }
}

function responseOutcome(status: number): ConnectionTestOutcome {
  if (status >= 200 && status <= 299)
    return Object.freeze({ ok: true, httpStatus: status });
  if (status === 401 || status === 403)
    return Object.freeze({
      ok: false,
      httpStatus: status,
      errorCode: 'connection.credential_rejected',
      reauthorizationRequired: true,
    });
  const errorCode =
    status === 429
      ? 'connection.provider_rate_limited'
      : status >= 500
        ? 'connection.provider_unavailable'
        : 'connection.provider_rejected';
  return Object.freeze({
    ok: false,
    httpStatus: status,
    errorCode,
    reauthorizationRequired: false,
  });
}

function secureErrorOutcome(error: SecureHttpError): ConnectionTestOutcome {
  return Object.freeze({
    ok: false,
    httpStatus: null,
    errorCode: `connection.test.${error.code}`,
    reauthorizationRequired: false,
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

function toTestResponse(result: ConnectionTestResult): ConnectionTestResponse {
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
