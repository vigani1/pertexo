import { randomUUID } from 'node:crypto';

import type { ConnectionTestOutcome } from '@pertexo/database/api';
import {
  ConnectionSecretEncryptionError,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
} from '@pertexo/integrations/server';

import type { WorkspaceAuthorizationSource } from '../workspaces/index.js';
import {
  authorizeConnectionOperation,
  reauthorizeConnectionSecretAccess,
} from './authorization.js';
import type {
  ConnectionEmailClient,
  ConnectionHttpClient,
  ConnectionSecretEncryptionPort,
  ConnectionSlackClient,
  ConnectionTestPersistence,
} from './ports.js';
import {
  connectionTestProviderKey,
  encryptionSignal,
  hashRequest,
  toTestResponse,
  type ConnectionCommandInput,
} from './use-case-support.js';
import {
  CONNECTION_OPERATION,
  NOOP_CONNECTION_TELEMETRY,
  type ConnectionTelemetry,
} from './telemetry.js';
import {
  connectionTestRequestSchema,
  httpHeadersCredentialSchema,
  resendApiKeyCredentialSchema,
  slackBotTokenCredentialSchema,
  type ConnectionTestResponse,
} from './types.js';

export type TestConnectionCommand = ConnectionCommandInput &
  Readonly<{
    connectionId: string;
    request: unknown;
    idempotencyKey: string;
  }>;

export class TestConnectionUseCase {
  public constructor(
    private readonly persistence: ConnectionTestPersistence,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly encryption: ConnectionSecretEncryptionPort,
    private readonly httpClient: ConnectionHttpClient,
    private readonly telemetry: ConnectionTelemetry = NOOP_CONNECTION_TELEMETRY,
    private readonly slackClient?: ConnectionSlackClient,
    private readonly emailClient?: ConnectionEmailClient,
  ) {}

  public execute(
    input: TestConnectionCommand,
  ): Promise<ConnectionTestResponse> {
    return this.telemetry.measure(CONNECTION_OPERATION.test, async () => {
      await authorizeConnectionOperation(
        input,
        this.authorization,
        'connection:use',
      );
      const request = connectionTestRequestSchema.parse(input.request);
      const expectedProviderKey =
        'url' in request ? 'http' : request.providerKey;
      const requestHash = hashRequest({
        connectionId: input.connectionId,
        ...request,
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
        expectedProviderKey,
      });
      if (started.kind === 'replay') return toTestResponse(started.result);

      let plaintext: Uint8Array | undefined;
      try {
        await reauthorizeConnectionSecretAccess(input, this.authorization);
        const resolved = await this.persistence.resolveConnectionTestSecret({
          ...common,
          expectedProviderKey,
        });
        plaintext = await this.encryption.open(
          resolved.sealed,
          {
            workspaceId: input.routeWorkspaceId,
            connectionId: input.connectionId,
            secretVersionId: resolved.secretVersionId,
          },
          encryptionSignal(input),
        );
        const credential = decodeCredential(plaintext);
        try {
          if (expectedProviderKey === 'email') {
            if (
              credential.type !== 'resend_api_key' ||
              this.emailClient === undefined
            )
              throw new ConnectionSecretEncryptionError();
            const result = await this.emailClient.sendNotification({
              apiKey: credential.apiKey,
              fromEmail: credential.fromEmail,
              toEmail: 'delivered@resend.dev',
              subject: 'Pertexo Resend connection test',
              text: 'This message verifies a Pertexo Resend sending connection.',
              idempotencyKey: connectionTestProviderKey(
                input.connectionId,
                input.idempotencyKey,
              ),
              timeoutMillis: 15_000,
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
                outcome: resendTestOutcome(result),
              }),
            );
          }
          if (expectedProviderKey === 'slack') {
            if (
              credential.type !== 'slack_bot_token' ||
              this.slackClient === undefined
            )
              throw new ConnectionSecretEncryptionError();
            const result = await this.slackClient.authTest({
              botToken: credential.botToken,
              timeoutMillis: 15_000,
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
                outcome: slackTestOutcome(result),
              }),
            );
          }
          if (credential.type !== 'http_headers' || !('url' in request))
            throw new ConnectionSecretEncryptionError();
          const response = await this.httpClient.execute({
            url: request.url,
            method: 'GET',
            headers: credential.headers,
            timeoutMillis: 15_000,
            maxRedirects: 3,
            maxResponseBytes: 65_536,
            sensitiveValues: Object.values(credential.headers),
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

function decodeCredential(plaintext: Uint8Array) {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(plaintext),
    );
    if (value !== null && typeof value === 'object' && 'type' in value) {
      if (value.type === 'slack_bot_token')
        return slackBotTokenCredentialSchema.parse(value);
      if (value.type === 'resend_api_key')
        return resendApiKeyCredentialSchema.parse(value);
    }
    return httpHeadersCredentialSchema.parse(value);
  } catch {
    throw new ConnectionSecretEncryptionError();
  }
}

function slackTestOutcome(
  result: Awaited<ReturnType<ConnectionSlackClient['authTest']>>,
): ConnectionTestOutcome {
  switch (result.kind) {
    case 'succeeded':
      return Object.freeze({ ok: true, httpStatus: 200 });
    case 'rate_limited':
      return Object.freeze({
        ok: false,
        httpStatus: 429,
        errorCode: 'connection.provider_rate_limited',
        reauthorizationRequired: false,
      });
    case 'http_failure':
      return responseOutcome(result.status);
    case 'invalid_response':
      return Object.freeze({
        ok: false,
        httpStatus: null,
        errorCode: 'connection.provider_invalid_response',
        reauthorizationRequired: false,
      });
    case 'rejected': {
      const rejected = new Set([
        'account_inactive',
        'invalid_auth',
        'not_authed',
        'token_revoked',
      ]);
      return Object.freeze({
        ok: false,
        httpStatus: 200,
        errorCode: rejected.has(result.error)
          ? 'connection.credential_rejected'
          : 'connection.provider_rejected',
        reauthorizationRequired: rejected.has(result.error),
      });
    }
  }
  throw new TypeError('Unsupported Slack connection-test outcome');
}

function resendTestOutcome(
  result: Awaited<ReturnType<ConnectionEmailClient['sendNotification']>>,
): ConnectionTestOutcome {
  switch (result.kind) {
    case 'succeeded':
      return Object.freeze({ ok: true, httpStatus: 200 });
    case 'rate_limited':
      return Object.freeze({
        ok: false,
        httpStatus: 429,
        errorCode: 'connection.provider_rate_limited',
        reauthorizationRequired: false,
      });
    case 'http_failure':
      return responseOutcome(result.status);
    case 'invalid_response':
      return Object.freeze({
        ok: false,
        httpStatus: null,
        errorCode: 'connection.provider_invalid_response',
        reauthorizationRequired: false,
      });
    case 'rejected':
      return responseOutcome(result.status);
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
  return Object.freeze({
    ok: false,
    httpStatus: status,
    errorCode:
      status === 429
        ? 'connection.provider_rate_limited'
        : status >= 500
          ? 'connection.provider_unavailable'
          : 'connection.provider_rejected',
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
