import {
  ConnectionSecretEncryptionError,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  type SecureHttpRequest,
} from '@pertexo/integrations/server';
import { describe, expect, it, vi } from 'vitest';

import type {
  ConnectionHttpClient,
  ConnectionEmailClient,
  ConnectionSlackClient,
  ConnectionTestPersistence,
} from '../../src/connections/ports.js';
import {
  TestConnectionUseCase,
  type TestConnectionCommand,
} from '../../src/connections/use-cases.js';
import { authorizeWorkspace } from '../../src/workspaces/index.js';
import {
  actor,
  actorId,
  authorization,
  connectionId,
  connectionTestPersistence,
  credential,
  record,
  sealed,
  secretVersionId,
  workspaceId,
} from './support/use-case-fixture.js';

describe('connection testing use case', () => {
  it('rejects an invalid connection-test body before claiming work', async () => {
    const testCommand: TestConnectionCommand = {
      actor,
      routeWorkspaceId: workspaceId,
      connectionId,
      idempotencyKey: 'test-invalid',
      request: { url: 'http://provider.example.test/health' },
    };
    const store = connectionTestPersistence();
    const open = vi.fn();
    const execute = vi.fn();

    await expect(
      new TestConnectionUseCase(
        store,
        authorization(),
        { open, seal: vi.fn() },
        { execute },
      ).execute(testCommand),
    ).rejects.toMatchObject({ name: 'ZodError' });

    expect(store.startConnectionTest).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('decrypts just in time, commits dispatch evidence, and stores only a safe test result', async () => {
    const store = connectionTestPersistence();
    const access = authorization();
    const authorizedWorkspace = await authorizeWorkspace({
      actor,
      routeWorkspaceId: workspaceId,
      capability: 'connection:use',
      access,
      disclosure: 'not_found',
    });
    let plaintext: Uint8Array | undefined;
    let responseBody: Uint8Array | undefined;
    const controller = new AbortController();
    const encryption = {
      seal: vi.fn(),
      open: vi.fn(() => {
        plaintext = new TextEncoder().encode(JSON.stringify(credential));
        return Promise.resolve(plaintext);
      }),
    };
    const httpClient: ConnectionHttpClient = {
      execute: vi.fn(async (input: SecureHttpRequest) => {
        expect(input).toMatchObject({
          url: 'https://provider.example.test/health',
          method: 'GET',
          headers: { authorization: 'Bearer deeply-secret-value' },
          sensitiveValues: ['Bearer deeply-secret-value'],
          signal: controller.signal,
        });
        await input.beforeDispatch();
        responseBody = new TextEncoder().encode('provider response');
        return {
          status: 204,
          headers: {},
          body: responseBody,
          bodyEncoding: 'utf8' as const,
          finalUrl: 'https://provider.example.test',
          redirectCount: 0,
        };
      }),
    };

    const result = await new TestConnectionUseCase(
      store,
      access,
      encryption,
      httpClient,
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      authorizedWorkspace,
      connectionId,
      idempotencyKey: 'test-42',
      requestId: 'request-42',
      request: { url: 'https://provider.example.test/health' },
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      connection: { id: connectionId },
      outcome: { ok: true, httpStatus: 204, errorCode: null },
    });
    expect(store.markConnectionTestDispatched).toHaveBeenCalledOnce();
    expect(access.findAccess).toHaveBeenCalledTimes(2);
    expect(store.completeConnectionTest).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { ok: true, httpStatus: 204 } }),
    );
    expect(plaintext?.every((byte) => byte === 0)).toBe(true);
    expect(responseBody?.every((byte) => byte === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('deeply-secret-value');
  });

  it('replays a completed test without decrypting or contacting the provider', async () => {
    const replay = {
      connection: record({
        lastTestedAt: new Date('2026-08-22T12:01:00.000Z'),
        lastHealthyAt: new Date('2026-08-22T12:01:00.000Z'),
      }),
      outcome: { ok: true as const, httpStatus: 200 },
    };
    const store = connectionTestPersistence({
      startConnectionTest: vi.fn().mockResolvedValue({
        kind: 'replay',
        result: replay,
      }),
    });
    const encryption = { seal: vi.fn(), open: vi.fn() };
    const httpClient = { execute: vi.fn() };

    const result = await new TestConnectionUseCase(
      store,
      authorization(),
      encryption,
      httpClient,
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      connectionId,
      idempotencyKey: 'test-replay',
      request: { url: 'https://provider.example.test/health' },
    });

    expect(result.outcome).toEqual({
      ok: true,
      httpStatus: 200,
      errorCode: null,
    });
    expect(encryption.open).not.toHaveBeenCalled();
    expect(httpClient.execute).not.toHaveBeenCalled();
  });

  it('tests a Slack bot token only through one fixed auth.test client call', async () => {
    const controller = new AbortController();
    const slackCredential = {
      schemaVersion: 1,
      type: 'slack_bot_token',
      botToken: 'xoxb-123456789-deeply-secret',
    } as const;
    const slackRecord = record({
      providerKey: 'slack',
      authType: 'slack_bot_token',
      name: 'Operations Slack',
    });
    const store = connectionTestPersistence({
      resolveConnectionTestSecret: vi.fn(() =>
        Promise.resolve({ connection: slackRecord, secretVersionId, sealed }),
      ),
      completeConnectionTest: vi.fn<
        ConnectionTestPersistence['completeConnectionTest']
      >((input) =>
        Promise.resolve({ connection: slackRecord, outcome: input.outcome }),
      ),
    });
    const plaintext = new TextEncoder().encode(JSON.stringify(slackCredential));
    const authTest = vi.fn<ConnectionSlackClient['authTest']>(async (input) => {
      expect(input.botToken).toBe(slackCredential.botToken);
      expect(input.timeoutMillis).toBe(15_000);
      expect(input.signal).toBe(controller.signal);
      await input.beforeDispatch();
      return { kind: 'succeeded' };
    });

    const result = await new TestConnectionUseCase(
      store,
      authorization(),
      { seal: vi.fn(), open: vi.fn(() => Promise.resolve(plaintext)) },
      { execute: vi.fn() },
      undefined,
      { authTest },
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      connectionId,
      idempotencyKey: 'test-slack',
      request: { providerKey: 'slack' },
      signal: controller.signal,
    });

    expect(result.outcome).toEqual({
      ok: true,
      httpStatus: 200,
      errorCode: null,
    });
    expect(store.startConnectionTest).toHaveBeenCalledWith(
      expect.objectContaining({ expectedProviderKey: 'slack' }),
    );
    expect(authTest).toHaveBeenCalledOnce();
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it('tests Resend only after disclosure with one fixed message and stable provider key', async () => {
    const controller = new AbortController();
    const emailRecord = record({
      providerKey: 'email',
      authType: 'resend_api_key',
      name: 'Transactional email',
    });
    const store = connectionTestPersistence({
      resolveConnectionTestSecret: vi.fn(() =>
        Promise.resolve({ connection: emailRecord, secretVersionId, sealed }),
      ),
      completeConnectionTest: vi.fn<
        ConnectionTestPersistence['completeConnectionTest']
      >((input) =>
        Promise.resolve({ connection: emailRecord, outcome: input.outcome }),
      ),
    });
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        type: 'resend_api_key',
        apiKey: 're_123456789_secret',
        fromEmail: 'Sender@Example.COM',
      }),
    );
    const sendNotification = vi.fn<ConnectionEmailClient['sendNotification']>(
      async (input) => {
        expect(input).toMatchObject({
          apiKey: 're_123456789_secret',
          fromEmail: 'Sender@example.com',
          toEmail: 'delivered@resend.dev',
          subject: 'Pertexo Resend connection test',
          text: 'This message verifies a Pertexo Resend sending connection.',
          timeoutMillis: 15_000,
          signal: controller.signal,
        });
        expect(input.idempotencyKey).toBe(
          'pertexo-connection-test-v1-36c369e31f137800ce05532683713337647e2ee5f72338fcb09f7fab95e1f5e6',
        );
        await input.beforeDispatch();
        return {
          kind: 'succeeded',
          emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
        };
      },
    );
    const useCase = new TestConnectionUseCase(
      store,
      authorization(),
      { seal: vi.fn(), open: vi.fn(() => Promise.resolve(plaintext)) },
      { execute: vi.fn() },
      undefined,
      undefined,
      { sendNotification },
    );
    const command = {
      actor,
      routeWorkspaceId: workspaceId,
      connectionId,
      idempotencyKey: 'test-email-stable',
    };

    await expect(
      useCase.execute({
        ...command,
        request: {
          providerKey: 'email',
          sideEffectDisclosureAccepted: true,
        },
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ outcome: { ok: true, httpStatus: 200 } });
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(store.markConnectionTestDispatched).toHaveBeenCalledOnce();
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it('does not contact a provider when cancellation races decryption completion', async () => {
    const controller = new AbortController();
    const store = connectionTestPersistence();
    const plaintext = new TextEncoder().encode(JSON.stringify(credential));
    const execute = vi.fn();
    const encryption = {
      seal: vi.fn(),
      open: vi.fn(() => {
        controller.abort();
        return Promise.resolve(plaintext);
      }),
    };

    await expect(
      new TestConnectionUseCase(store, authorization(), encryption, {
        execute,
      }).execute({
        actor,
        routeWorkspaceId: workspaceId,
        connectionId,
        idempotencyKey: 'test-canceled-after-decryption',
        request: { url: 'https://provider.example.test/health' },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(execute).not.toHaveBeenCalled();
    expect(store.markConnectionTestDispatched).not.toHaveBeenCalled();
    expect(store.completeConnectionTest).not.toHaveBeenCalled();
    expect(store.abandonConnectionTest).toHaveBeenCalledOnce();
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    { providerKey: 'email' },
    { providerKey: 'email', sideEffectDisclosureAccepted: false },
  ])(
    'rejects email test disclosure %j before claim, secret open, or dispatch',
    async (request) => {
      const store = connectionTestPersistence();
      const open = vi.fn();
      const sendNotification = vi.fn();
      await expect(
        new TestConnectionUseCase(
          store,
          authorization(),
          { seal: vi.fn(), open },
          { execute: vi.fn() },
          undefined,
          undefined,
          { sendNotification },
        ).execute({
          actor,
          routeWorkspaceId: workspaceId,
          connectionId,
          idempotencyKey: 'test-email-disclosure',
          request,
        }),
      ).rejects.toBeDefined();
      expect(store.startConnectionTest).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(sendNotification).not.toHaveBeenCalled();
    },
  );

  it('denies a viewer before claiming or decrypting a connection test', async () => {
    const store = connectionTestPersistence();
    const deniedAuthorization = {
      findAccess: vi.fn().mockResolvedValue({
        actorId,
        workspaceId,
        role: 'viewer' as const,
        membershipStatus: 'active' as const,
        workspaceStatus: 'active' as const,
      }),
    };
    const encryption = { seal: vi.fn(), open: vi.fn() };
    const httpClient = { execute: vi.fn() };

    await expect(
      new TestConnectionUseCase(
        store,
        deniedAuthorization,
        encryption,
        httpClient,
      ).execute({
        actor,
        routeWorkspaceId: workspaceId,
        connectionId,
        idempotencyKey: 'test-viewer',
        request: { url: 'https://provider.example.test/health' },
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(store.startConnectionTest).not.toHaveBeenCalled();
    expect(encryption.open).not.toHaveBeenCalled();
  });

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
            false,
          ),
        ),
    };
    const failed = await new TestConnectionUseCase(
      securityStore,
      authorization(),
      encryption,
      securityClient,
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
            false,
          ),
        ),
    };
    await expect(
      new TestConnectionUseCase(
        markerStore,
        authorization(),
        encryption,
        markerClient,
      ).execute({
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
      const result = await new TestConnectionUseCase(
        store,
        authorization(),
        {
          seal: vi.fn(),
          open: vi.fn(() =>
            Promise.resolve(
              new TextEncoder().encode(JSON.stringify(credential)),
            ),
          ),
        },
        {
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
      ).execute({
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
      'connection.credential_rejected',
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
          schemaVersion: 1,
          type: 'slack_bot_token',
          botToken: 'xoxb-123456789-deeply-secret',
        }),
      );
      const result = await new TestConnectionUseCase(
        store,
        authorization(),
        { seal: vi.fn(), open: vi.fn(() => Promise.resolve(plaintext)) },
        { execute: vi.fn() },
        undefined,
        { authTest: vi.fn().mockResolvedValue(providerResult) },
      ).execute({
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
          schemaVersion: 1,
          type: 'resend_api_key',
          apiKey: 're_123456789_secret',
          fromEmail: 'sender@example.com',
        }),
      );
      const result = await new TestConnectionUseCase(
        store,
        authorization(),
        { seal: vi.fn(), open: vi.fn(() => Promise.resolve(plaintext)) },
        { execute: vi.fn() },
        undefined,
        undefined,
        { sendNotification: vi.fn().mockResolvedValue(providerResult) },
      ).execute({
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

  it('rejects a decrypted credential with a non-object JSON shape', async () => {
    const store = connectionTestPersistence();
    const plaintext = new TextEncoder().encode('null');
    const execute = vi.fn();

    await expect(
      new TestConnectionUseCase(
        store,
        authorization(),
        { seal: vi.fn(), open: vi.fn(() => Promise.resolve(plaintext)) },
        { execute },
      ).execute({
        actor,
        routeWorkspaceId: workspaceId,
        connectionId,
        idempotencyKey: 'malformed-decrypted-credential',
        request: { url: 'https://provider.example.test/health' },
      }),
    ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);

    expect(execute).not.toHaveBeenCalled();
    expect(store.abandonConnectionTest).toHaveBeenCalledOnce();
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it.each(['email', 'slack', 'http'] as const)(
    'rejects a decrypted credential that does not match the %s test route',
    async (provider) => {
      const store = connectionTestPersistence();
      const plaintext = new TextEncoder().encode(
        JSON.stringify(
          provider === 'http'
            ? {
                schemaVersion: 1,
                type: 'slack_bot_token',
                botToken: 'xoxb-123456789-deeply-secret',
              }
            : credential,
        ),
      );
      await expect(
        new TestConnectionUseCase(
          store,
          authorization(),
          { seal: vi.fn(), open: vi.fn(() => Promise.resolve(plaintext)) },
          { execute: vi.fn() },
          undefined,
          provider === 'slack'
            ? undefined
            : { authTest: vi.fn().mockResolvedValue({ kind: 'succeeded' }) },
          provider === 'email'
            ? undefined
            : {
                sendNotification: vi
                  .fn()
                  .mockResolvedValue({ kind: 'succeeded' }),
              },
        ).execute({
          actor,
          routeWorkspaceId: workspaceId,
          connectionId,
          idempotencyKey: `mismatched-${provider}`,
          request:
            provider === 'http'
              ? { url: 'https://provider.example.test/health' }
              : provider === 'slack'
                ? { providerKey: 'slack' }
                : {
                    providerKey: 'email',
                    sideEffectDisclosureAccepted: true,
                  },
        }),
      ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);
      expect(store.abandonConnectionTest).toHaveBeenCalledOnce();
      expect(plaintext.every((byte) => byte === 0)).toBe(true);
    },
  );
});
