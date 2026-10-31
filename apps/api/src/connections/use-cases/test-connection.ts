import type { FailureNotificationDestinationResponse } from '@pertexo/contracts';
import { randomUUID } from 'node:crypto';
import { CONNECTION_AUTH_TYPE } from '@pertexo/database/connections';
import type {
  ConnectionRecord,
  ConnectionTestOutcome,
} from '@pertexo/database/connections';
import {
  ConnectionSecretEncryptionError,
  createOAuth2RenewalClient,
  decodeClientSettings,
  isOAuth2HostAllowed,
  OAuth2TokenFailure,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  type OAuth2TokenScope,
} from '@pertexo/integrations/server';
import type { WorkspaceAuthorizationSource } from '../../authorization/index.js';
import {
  authorizeConnectionOperation,
  reauthorizeConnectionSecretAccess,
} from '../authorization.js';
import type {
  ConnectionEmailClient,
  ConnectionHttpClient,
  ConnectionOAuth2Dependencies,
  ConnectionSecretEncryptionPort,
  ConnectionSlackClient,
  ConnectionTestPersistence,
} from '../ports.js';
import {
  connectionTestProviderKey,
  encryptionSignal,
  hashRequest,
  toTestResponse,
  type ConnectionCommandInput,
} from './support.js';
import {
  CONNECTION_OPERATION,
  NOOP_CONNECTION_TELEMETRY,
  type ConnectionTelemetry,
} from '../telemetry.js';
import {
  connectionTestRequestSchema,
  type ConnectionTestResponse,
} from '../types.js';
import { decodeCredential } from './testing/credentials.js';
import {
  oauth2ApiResponseOutcome,
  oauth2NotActiveOutcome,
  oauth2TokenFailureOutcome,
  slackTestOutcome,
  resendTestOutcome,
  responseOutcome,
  secureErrorOutcome,
} from './testing/outcomes.js';
import { oauth2RedirectUri } from '../oauth2/start-authorization.js';

const CONNECTION_TEST_TIMEOUT_MILLIS = 15_000;

const CONNECTION_TEST_MAXIMUM_REDIRECTS = 3;

const CONNECTION_TEST_MAXIMUM_RESPONSE_BYTES = 65_536;

type ParsedConnectionTestRequest = ReturnType<
  typeof connectionTestRequestSchema.parse
>;

type DecodedConnectionCredential = ReturnType<typeof decodeCredential>;

export type TestConnectionCommand = ConnectionCommandInput &
  Readonly<{
    connectionId: string;
    request: unknown;
    idempotencyKey: string;
  }>;

export class TestConnectionUseCase {
  private readonly encryption: ConnectionSecretEncryptionPort;
  private readonly httpClient: ConnectionHttpClient;
  private readonly applicationSecret: string;
  private readonly telemetry: ConnectionTelemetry;
  private readonly slackClient?:
    Pick<ConnectionSlackClient, 'authTest' | 'sendMessage'> | undefined;
  private readonly emailClient?: ConnectionEmailClient | undefined;
  private readonly oauth2?: ConnectionOAuth2Dependencies | undefined;
  public constructor(
    private readonly persistence: ConnectionTestPersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    {
      encryption,
      httpClient,
      applicationSecret,
      telemetry = NOOP_CONNECTION_TELEMETRY,
      slackClient,
      emailClient,
      oauth2,
    }: Readonly<{
      encryption: ConnectionSecretEncryptionPort;
      httpClient: ConnectionHttpClient;
      applicationSecret: string;
      telemetry?: ConnectionTelemetry | undefined;
      slackClient?:
        Pick<ConnectionSlackClient, 'authTest' | 'sendMessage'> | undefined;
      emailClient?: ConnectionEmailClient | undefined;
      oauth2?: ConnectionOAuth2Dependencies | undefined;
    }>,
  ) {
    this.encryption = encryption;
    this.httpClient = httpClient;
    this.applicationSecret = applicationSecret;
    this.telemetry = telemetry;
    this.slackClient = slackClient;
    this.emailClient = emailClient;
    this.oauth2 = oauth2;
  }

  private redirectUri(): string | undefined {
    return this.oauth2 === undefined
      ? undefined
      : oauth2RedirectUri(this.oauth2.endpointPolicy.publicWebOrigin);
  }

  public execute(
    input: TestConnectionCommand,
  ): Promise<ConnectionTestResponse> {
    return this.run(input);
  }

  /** The target is resolved and authorized by the destination use case, never caller supplied. */
  public executeDestination(
    input: Omit<TestConnectionCommand, 'connectionId' | 'request'>,
    destination: FailureNotificationDestinationResponse,
  ): Promise<ConnectionTestResponse> {
    return this.run(
      {
        ...input,
        connectionId: destination.config.connectionId,
        request:
          destination.kind === 'email'
            ? { providerKey: 'email', sideEffectDisclosureAccepted: true }
            : { providerKey: 'slack' },
      },
      destination,
    );
  }

  private run(
    input: TestConnectionCommand,
    destination?: FailureNotificationDestinationResponse,
  ): Promise<ConnectionTestResponse> {
    return this.telemetry.measure(CONNECTION_OPERATION.test, async () => {
      // Testing a destination is part of managing it, as its route's guard says.
      // Secret access is still rechecked for connection:use before dispatch.
      await authorizeConnectionOperation(
        input,
        this.authorization,
        destination === undefined ? 'connection:use' : 'connection:manage',
      );
      const request = connectionTestRequestSchema.parse(input.request);
      const expectedProviderKey =
        'url' in request ? 'http' : request.providerKey;
      const requestHash = hashRequest(
        this.applicationSecret,
        input.routeWorkspaceId,
        CONNECTION_OPERATION.test,
        {
          connectionId: input.connectionId,
          ...request,
          ...(destination === undefined
            ? {}
            : {
                destinationId: destination.id,
                configVersion: destination.currentVersion,
                config: destination.config,
              }),
        },
      );
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
        expectedProviderKey,
      });
      if (started.kind === 'replay')
        return toTestResponse(started.result, this.redirectUri());
      const requestSignal = encryptionSignal(input);

      let plaintext: Uint8Array | undefined;
      try {
        requestSignal.throwIfAborted();
        await reauthorizeConnectionSecretAccess(input, this.authorization);
        const resolved = await this.persistence.resolveConnectionTestSecret({
          ...common,
          expectedProviderKey,
        });
        // An OAuth2 test needs no client secret unless its token is due, and the
        // token service opens that for itself.
        if (resolved.connection.authType === CONNECTION_AUTH_TYPE.oauth2) {
          const outcome = await this.testOAuth2(input, request, {
            connection: resolved.connection,
            signal: requestSignal,
            beforeDispatch: () =>
              this.persistence.markConnectionTestDispatched({
                ...common,
                secretVersionId: resolved.secretVersionId,
              }),
          });
          return toTestResponse(
            await this.persistence.completeConnectionTest({
              ...common,
              secretVersionId: resolved.secretVersionId,
              outcome,
            }),
            this.redirectUri(),
          );
        }
        plaintext = await this.encryption.open(
          resolved.sealed,
          {
            workspaceId: input.routeWorkspaceId,
            connectionId: input.connectionId,
            secretVersionId: resolved.secretVersionId,
          },
          requestSignal,
        );
        requestSignal.throwIfAborted();
        const credential = decodeCredential(plaintext);
        try {
          const outcome = await this.testProvider(
            destination,
            expectedProviderKey,
            {
              request: request,
              credential: credential,
              input: input,
              signal: requestSignal,
              beforeDispatch: () =>
                this.persistence.markConnectionTestDispatched({
                  ...common,
                  secretVersionId: resolved.secretVersionId,
                }),
            },
          );
          return toTestResponse(
            await this.persistence.completeConnectionTest({
              ...common,
              secretVersionId: resolved.secretVersionId,
              outcome,
            }),
            this.redirectUri(),
          );
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
            this.redirectUri(),
          );
        }
      } catch (error: unknown) {
        try {
          await this.persistence.abandonConnectionTest(common);
        } catch {
          // Abandonment is cleanup and cannot replace the command failure.
        }
        throw error;
      } finally {
        plaintext?.fill(0);
      }
    });
  }

  /** Gets a token as a step would, and asks the URL once, renewing once on a 401. */
  private async testOAuth2(
    input: TestConnectionCommand,
    request: ParsedConnectionTestRequest,
    {
      connection,
      signal,
      beforeDispatch,
    }: Readonly<{
      connection: ConnectionRecord;
      signal: AbortSignal;
      beforeDispatch: () => Promise<void>;
    }>,
  ): Promise<ConnectionTestOutcome> {
    if (
      this.oauth2 === undefined ||
      !('url' in request) ||
      connection.oauth2 === undefined
    )
      throw new ConnectionSecretEncryptionError();
    if (connection.status !== 'active')
      return oauth2NotActiveOutcome(connection.lastErrorCode);
    const { requestHosts } = decodeClientSettings(connection.oauth2.settings);
    if (!isOAuth2HostAllowed(requestHosts, request.url))
      return oauth2TokenFailureOutcome('http.oauth2_host_not_allowed');
    const { tokens, apiClient } = this.oauth2;
    const scope: OAuth2TokenScope = {
      workspaceId: input.routeWorkspaceId,
      connectionId: input.connectionId,
      loss: {
        source: 'test',
        actorId: input.actor.actorId,
        ...(input.requestId === undefined
          ? {}
          : { requestId: input.requestId }),
        ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      },
    };
    let dispatched = false;
    try {
      const client = createOAuth2RenewalClient({
        client: apiClient,
        credential: await tokens.accessToken(scope, signal),
        reject: (tokenVersionId) =>
          tokens.rejectToken(scope, tokenVersionId, signal),
        renew: () => tokens.accessToken(scope, signal),
      });
      const response = await client.executeStreaming(
        {
          url: request.url,
          method: 'GET',
          timeoutMillis: CONNECTION_TEST_TIMEOUT_MILLIS,
          maxRedirects: CONNECTION_TEST_MAXIMUM_REDIRECTS,
          maxResponseBytes: CONNECTION_TEST_MAXIMUM_RESPONSE_BYTES,
          signal,
          // A repeat after a 401 is the same test, so its evidence is written once.
          beforeDispatch: async () => {
            if (dispatched) return;
            await beforeDispatch();
            dispatched = true;
          },
        },
        async (stream) => {
          for await (const chunk of stream.body) new Uint8Array(chunk).fill(0);
        },
      );
      return oauth2ApiResponseOutcome(response.status);
    } catch (error: unknown) {
      if (!(error instanceof OAuth2TokenFailure)) throw error;
      return error.code === 'http.oauth2_not_connected'
        ? oauth2NotActiveOutcome(connection.lastErrorCode)
        : oauth2TokenFailureOutcome(error.code);
    }
  }

  private async testProvider(
    destination: FailureNotificationDestinationResponse | undefined,
    expectedProviderKey: 'email' | 'http' | 'slack' | 'signing',
    {
      request,
      credential,
      input,
      signal,
      beforeDispatch,
    }: Readonly<{
      request: ParsedConnectionTestRequest;
      credential: DecodedConnectionCredential;
      input: TestConnectionCommand;
      signal: AbortSignal;
      beforeDispatch: () => Promise<void>;
    }>,
  ): Promise<ConnectionTestOutcome> {
    if (expectedProviderKey === 'email') {
      if (
        credential.type !== 'resend_api_key' ||
        this.emailClient === undefined
      )
        throw new ConnectionSecretEncryptionError();
      const result = await this.emailClient.sendNotification({
        apiKey: credential.apiKey,
        fromEmail: credential.fromEmail,
        toEmail:
          destination?.config.kind === 'email'
            ? destination.config.toEmail
            : 'delivered@resend.dev',
        subject:
          destination === undefined
            ? 'Pertexo Resend connection test'
            : 'Pertexo alert destination test',
        text:
          destination === undefined
            ? 'This message verifies a Pertexo Resend sending connection.'
            : 'This is a test of your Pertexo alert destination. No workflow failed.',
        idempotencyKey: connectionTestProviderKey(
          input.connectionId,
          input.idempotencyKey,
        ),
        timeoutMillis: CONNECTION_TEST_TIMEOUT_MILLIS,
        signal,
        beforeDispatch,
      });
      return resendTestOutcome(result);
    }
    if (expectedProviderKey === 'slack') {
      if (
        credential.type !== 'slack_bot_token' ||
        this.slackClient === undefined
      )
        throw new ConnectionSecretEncryptionError();
      if (destination?.config.kind === 'slack') {
        if (this.slackClient.sendMessage === undefined)
          throw new ConnectionSecretEncryptionError();
        const result = await this.slackClient.sendMessage({
          botToken: credential.botToken,
          channelId: destination.config.channelId,
          text: 'This is a test of your Pertexo alert destination. No workflow failed.',
          timeoutMillis: CONNECTION_TEST_TIMEOUT_MILLIS,
          signal,
          beforeDispatch,
        });
        return slackTestOutcome(result);
      }
      const result = await this.slackClient.authTest({
        botToken: credential.botToken,
        timeoutMillis: CONNECTION_TEST_TIMEOUT_MILLIS,
        signal,
        beforeDispatch,
      });
      return slackTestOutcome(result);
    }
    if (
      credential.type === 'hmac_key' &&
      'providerKey' in request &&
      request.providerKey === 'signing'
    ) {
      await beforeDispatch();
      return Object.freeze({ ok: true, httpStatus: 200 });
    }
    if (credential.type !== 'http_headers' || !('url' in request))
      throw new ConnectionSecretEncryptionError();
    const response = await this.httpClient.execute({
      url: request.url,
      method: 'GET',
      headers: credential.headers,
      timeoutMillis: CONNECTION_TEST_TIMEOUT_MILLIS,
      maxRedirects: CONNECTION_TEST_MAXIMUM_REDIRECTS,
      maxResponseBytes: CONNECTION_TEST_MAXIMUM_RESPONSE_BYTES,
      sensitiveValues: Object.values(credential.headers),
      signal,
      beforeDispatch,
    });
    try {
      return responseOutcome(response.status);
    } finally {
      response.body.fill(0);
    }
  }
}
