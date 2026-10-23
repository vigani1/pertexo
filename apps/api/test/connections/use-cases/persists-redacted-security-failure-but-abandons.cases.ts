import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  type SecureHttpRequest,
} from '@pertexo/integrations/server';
import { expect, it, vi } from 'vitest';

import { TestConnectionUseCase } from '../../../src/connections/use-cases/management.js';

import {
  actor,
  authorization,
  connectionId,
  connectionTestPersistence,
  credential,
  workspaceId,
} from '../support/use-case-fixture.js';

export function registerPersistsRedactedSecurityFailureButAbandons(): void {
  it('persists a redacted security failure but abandons a failed dispatch marker', async () => {
    const encryption = {
      seal: vi.fn(),
      open: vi.fn(() =>
        Promise.resolve(new TextEncoder().encode(JSON.stringify(credential))),
      ),
    };
    const securityStore = connectionTestPersistence();
    const securityClient = {
      execute: vi
        .fn()
        .mockRejectedValue(
          new SecureHttpError(
            SECURE_HTTP_ERROR_CODE.ssrfBlocked,
            'definite_failure',
            { possiblyDispatched: false },
          ),
        ),
    };
    const failed = await new TestConnectionUseCase(
      securityStore,
      authorization(),
      {
        encryption: encryption,
        httpClient: securityClient,
        applicationSecret: 'fixture-application-secret',
      },
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      connectionId,
      idempotencyKey: 'test-ssrf',
      request: { url: 'https://provider.example.test/health' },
    });
    expect(failed.outcome).toEqual({
      ok: false,
      httpStatus: null,
      errorCode: 'connection.test.ssrf_blocked',
    });
    expect(securityStore.completeConnectionTest).toHaveBeenCalledOnce();

    const markerStore = connectionTestPersistence();
    const markerClient = {
      execute: vi
        .fn()
        .mockRejectedValue(
          new SecureHttpError(
            SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed,
            'definite_failure',
            { possiblyDispatched: false },
          ),
        ),
    };
    await expect(
      new TestConnectionUseCase(markerStore, authorization(), {
        encryption: encryption,
        httpClient: markerClient,
        applicationSecret: 'fixture-application-secret',
      }).execute({
        actor,
        routeWorkspaceId: workspaceId,
        connectionId,
        idempotencyKey: 'test-marker',
        request: { url: 'https://provider.example.test/health' },
      }),
    ).rejects.toMatchObject({
      code: SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed,
    });
    expect(markerStore.completeConnectionTest).not.toHaveBeenCalled();
    expect(markerStore.abandonConnectionTest).toHaveBeenCalledOnce();
  });

  it.each([
    [401, 'connection.credential_rejected'],
    [403, 'connection.credential_rejected'],
    [429, 'connection.provider_rate_limited'],
    [500, 'connection.provider_unavailable'],
    [400, 'connection.provider_rejected'],
  ] as const)(
    'classifies an HTTP connection test status %i as %s',
    async (status, errorCode) => {
      const store = connectionTestPersistence();
      const body = new Uint8Array();
      const result = await new TestConnectionUseCase(store, authorization(), {
        encryption: {
          seal: vi.fn(),
          open: vi.fn(() =>
            Promise.resolve(
              new TextEncoder().encode(JSON.stringify(credential)),
            ),
          ),
        },
        httpClient: {
          execute: vi.fn(async (input: SecureHttpRequest) => {
            await input.beforeDispatch();
            return {
              status,
              headers: {},
              body,
              bodyEncoding: 'utf8' as const,
              finalUrl: 'https://provider.example.test/health',
              redirectCount: 0,
            };
          }),
        },
        applicationSecret: 'fixture-application-secret',
      }).execute({
        actor,
        routeWorkspaceId: workspaceId,
        connectionId,
        idempotencyKey: `http-status-${String(status)}`,
        traceId: 'trace-http-status',
        request: { url: 'https://provider.example.test/health' },
      });

      expect(result.outcome).toEqual({
        ok: false,
        httpStatus: status,
        errorCode,
      });
      expect(store.completeConnectionTest).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [
      { kind: 'rate_limited', retryAfterSeconds: 2 },
      'connection.provider_rate_limited',
    ],
    [{ kind: 'http_failure', status: 503 }, 'connection.provider_unavailable'],
    [{ kind: 'invalid_response' }, 'connection.provider_invalid_response'],
    [
      { kind: 'rejected', error: 'invalid_auth' },
      'connection.provider_rejected',
    ],
    [
      { kind: 'rejected', error: 'team_disabled' },
      'connection.provider_rejected',
    ],
  ] as const)(
    'classifies Slack outcome %#',
    async (providerResult, errorCode) => {
      const store = connectionTestPersistence();
      const plaintext = new TextEncoder().encode(
        JSON.stringify({
          type: 'slack_bot_token',
          botToken: 'xoxb-123456789-deeply-secret',
        }),
      );
      const result = await new TestConnectionUseCase(store, authorization(), {
        encryption: {
          seal: vi.fn(),
          open: vi.fn(() => Promise.resolve(plaintext)),
        },
        httpClient: { execute: vi.fn() },
        applicationSecret: 'fixture-application-secret',
        telemetry: undefined,
        slackClient: { authTest: vi.fn().mockResolvedValue(providerResult) },
      }).execute({
        actor,
        routeWorkspaceId: workspaceId,
        connectionId,
        idempotencyKey: `slack-${providerResult.kind}`,
        request: { providerKey: 'slack' },
      });

      expect(result.outcome.errorCode).toBe(errorCode);
      expect(plaintext.every((byte) => byte === 0)).toBe(true);
    },
  );

  it.each([
    [
      { kind: 'rate_limited', retryAfterSeconds: 2 },
      'connection.provider_rate_limited',
    ],
    [{ kind: 'http_failure', status: 503 }, 'connection.provider_unavailable'],
    [{ kind: 'invalid_response' }, 'connection.provider_invalid_response'],
    [{ kind: 'rejected', status: 403 }, 'connection.credential_rejected'],
  ] as const)(
    'classifies email outcome %#',
    async (providerResult, errorCode) => {
      const store = connectionTestPersistence();
      const plaintext = new TextEncoder().encode(
        JSON.stringify({
          type: 'resend_api_key',
          apiKey: 're_123456789_secret',
          fromEmail: 'sender@example.com',
        }),
      );
      const result = await new TestConnectionUseCase(store, authorization(), {
        encryption: {
          seal: vi.fn(),
          open: vi.fn(() => Promise.resolve(plaintext)),
        },
        httpClient: { execute: vi.fn() },
        applicationSecret: 'fixture-application-secret',
        telemetry: undefined,
        slackClient: undefined,
        emailClient: {
          sendNotification: vi.fn().mockResolvedValue(providerResult),
        },
      }).execute({
        actor,
        routeWorkspaceId: workspaceId,
        connectionId,
        idempotencyKey: `email-${providerResult.kind}`,
        request: { providerKey: 'email', sideEffectDisclosureAccepted: true },
      });

      expect(result.outcome.errorCode).toBe(errorCode);
      expect(plaintext.every((byte) => byte === 0)).toBe(true);
    },
  );
}
