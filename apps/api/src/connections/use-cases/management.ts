import { ConnectionNotFoundError } from '@pertexo/database/connections';
import { generatePersistedId } from '@pertexo/database/platform';
import type { OAuth2Credential } from '@pertexo/contracts';
import { refusedEndpoint } from '@pertexo/integrations/server';

import type { WorkspaceAuthorizationSource } from '../../authorization/index.js';
import { authorizeConnectionOperation } from '../authorization.js';
import type {
  ConnectionCommandPersistence,
  ConnectionOAuth2Dependencies,
  ConnectionReadPersistence,
  ConnectionSecretEncryptionPort,
} from '../ports.js';
import { OAuth2EndpointRefusedError } from '../oauth2/errors.js';
import { oauth2RedirectUri } from '../oauth2/start-authorization.js';
import { decodeConnectionCursor, encodeConnectionCursor } from '../cursor.js';
import {
  encodeCredential,
  encryptionSignal,
  hashRequest,
  toListResponse,
  toResponse,
  type ConnectionCommandInput,
} from './support.js';
import {
  CONNECTION_OPERATION,
  NOOP_CONNECTION_TELEMETRY,
  type ConnectionTelemetry,
} from '../telemetry.js';
import {
  connectionCreateRequestSchema,
  connectionRotateSecretRequestSchema,
  type ConnectionResponse,
} from '../types.js';

export { TestConnectionUseCase } from './test-connection.js';
export type { TestConnectionCommand } from './test-connection.js';
export { LookupSlackChannelsUseCase } from '../failure-notifications/slack-channel-lookup.js';

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

type OAuth2EndpointPolicyHolder = Pick<
  ConnectionOAuth2Dependencies,
  'endpointPolicy'
>;

/** Settings are decided at the boundary, once, before anything is sealed. */
function assertOAuth2Endpoints(
  credential: OAuth2Credential,
  oauth2: OAuth2EndpointPolicyHolder | undefined,
): void {
  if (oauth2 === undefined)
    throw new Error('OAuth2 connections are not available on this install');
  const refused = refusedEndpoint(credential.settings, oauth2.endpointPolicy);
  if (refused !== undefined) throw new OAuth2EndpointRefusedError(refused);
}

const redirectUriOf = (oauth2: OAuth2EndpointPolicyHolder | undefined) =>
  oauth2 === undefined
    ? undefined
    : oauth2RedirectUri(oauth2.endpointPolicy.publicWebOrigin);

export class ListConnectionsUseCase {
  public constructor(
    private readonly persistence: ConnectionReadPersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: ConnectionTelemetry = NOOP_CONNECTION_TELEMETRY,
    private readonly oauth2?: OAuth2EndpointPolicyHolder,
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
        redirectUriOf(this.oauth2),
      );
    });
  }
}

export class GetConnectionUseCase {
  public constructor(
    private readonly persistence: ConnectionReadPersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: ConnectionTelemetry = NOOP_CONNECTION_TELEMETRY,
    private readonly oauth2?: OAuth2EndpointPolicyHolder,
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
      return toResponse(connection, redirectUriOf(this.oauth2));
    });
  }
}

export class CreateConnectionUseCase {
  private readonly encryption: Pick<ConnectionSecretEncryptionPort, 'seal'>;
  private readonly applicationSecret: string;
  private readonly telemetry: ConnectionTelemetry;
  private readonly oauth2: OAuth2EndpointPolicyHolder | undefined;
  public constructor(
    private readonly persistence: ConnectionCommandPersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    {
      encryption,
      applicationSecret,
      telemetry = NOOP_CONNECTION_TELEMETRY,
      oauth2,
    }: Readonly<{
      encryption: Pick<ConnectionSecretEncryptionPort, 'seal'>;
      applicationSecret: string;
      telemetry?: ConnectionTelemetry | undefined;
      oauth2?: OAuth2EndpointPolicyHolder | undefined;
    }>,
  ) {
    this.encryption = encryption;
    this.applicationSecret = applicationSecret;
    this.telemetry = telemetry;
    this.oauth2 = oauth2;
  }

  public execute(input: CreateConnectionCommand): Promise<ConnectionResponse> {
    return this.telemetry.measure(CONNECTION_OPERATION.create, async () => {
      await authorizeConnectionOperation(input, this.authorization);
      const request = connectionCreateRequestSchema.parse(input.request);
      if (request.credential.type === 'oauth2')
        assertOAuth2Endpoints(request.credential, this.oauth2);
      const requestHash = hashRequest(
        this.applicationSecret,
        input.routeWorkspaceId,
        CONNECTION_OPERATION.create,
        request,
      );
      const replay = await this.persistence.findConnectionCreateReplay({
        workspaceId: input.routeWorkspaceId,
        actorId: input.actor.actorId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
      });
      if (replay !== null)
        return toResponse(replay, redirectUriOf(this.oauth2));
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
            ...(request.credential.type === 'oauth2'
              ? {
                  authType: request.credential.type,
                  oauth2Settings: request.credential.settings,
                }
              : { authType: request.credential.type }),
            sealed,
            idempotencyKey: input.idempotencyKey,
            requestHash,
            ...(input.requestId === undefined
              ? {}
              : { requestId: input.requestId }),
            ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
          }),
          redirectUriOf(this.oauth2),
        );
      } finally {
        plaintext.fill(0);
      }
    });
  }
}

export class RotateConnectionSecretUseCase {
  private readonly encryption: Pick<ConnectionSecretEncryptionPort, 'seal'>;
  private readonly applicationSecret: string;
  private readonly telemetry: ConnectionTelemetry;
  private readonly oauth2: OAuth2EndpointPolicyHolder | undefined;
  public constructor(
    private readonly persistence: ConnectionCommandPersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    {
      encryption,
      applicationSecret,
      telemetry = NOOP_CONNECTION_TELEMETRY,
      oauth2,
    }: Readonly<{
      encryption: Pick<ConnectionSecretEncryptionPort, 'seal'>;
      applicationSecret: string;
      telemetry?: ConnectionTelemetry | undefined;
      oauth2?: OAuth2EndpointPolicyHolder | undefined;
    }>,
  ) {
    this.encryption = encryption;
    this.applicationSecret = applicationSecret;
    this.telemetry = telemetry;
    this.oauth2 = oauth2;
  }

  public execute(
    input: RotateConnectionSecretCommand,
  ): Promise<ConnectionResponse> {
    return this.telemetry.measure(CONNECTION_OPERATION.rotate, async () => {
      await authorizeConnectionOperation(input, this.authorization);
      const request = connectionRotateSecretRequestSchema.parse(input.request);
      if (request.credential.type === 'oauth2')
        assertOAuth2Endpoints(request.credential, this.oauth2);
      const secretVersionId = generatePersistedId();
      const requestHash = hashRequest(
        this.applicationSecret,
        input.routeWorkspaceId,
        CONNECTION_OPERATION.rotate,
        {
          connectionId: input.connectionId,
          ...request,
        },
      );
      const replay = await this.persistence.findConnectionRotateReplay({
        workspaceId: input.routeWorkspaceId,
        actorId: input.actor.actorId,
        connectionId: input.connectionId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
      });
      if (replay !== null)
        return toResponse(replay, redirectUriOf(this.oauth2));
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
            ...(request.credential.type === 'oauth2'
              ? {
                  expectedAuthType: request.credential.type,
                  oauth2Settings: request.credential.settings,
                }
              : { expectedAuthType: request.credential.type }),
            sealed,
            idempotencyKey: input.idempotencyKey,
            requestHash,
            ...(input.requestId === undefined
              ? {}
              : { requestId: input.requestId }),
            ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
          }),
          redirectUriOf(this.oauth2),
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
    private readonly oauth2?: OAuth2EndpointPolicyHolder,
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
        redirectUriOf(this.oauth2),
      );
    });
  }
}
