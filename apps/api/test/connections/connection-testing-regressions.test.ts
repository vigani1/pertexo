import type { ConnectionRecord } from '@pertexo/database/testing';
import {
  ConnectionSecretEncryptionError,
  type SecureHttpRequest,
} from '@pertexo/integrations/server';
import { describe, expect, it, vi } from 'vitest';

import { TestConnectionUseCase } from '../../src/connections/connection-testing.js';
import type {
  ConnectionEmailClient,
  ConnectionHttpClient,
  ConnectionSlackClient,
  ConnectionTestPersistence,
} from '../../src/connections/ports.js';
import { createActorContext } from '../../src/workspaces/index.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const secretVersionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  requestId: 'connection-test-regression',
});
const sealed = Object.freeze({
  schemaVersion: 1 as const,
  kmsKeyReference: 'alias/pertexo-connections',
  encryptedDataKey: 'encrypted-key',
  ciphertext: 'ciphertext',
  nonce: 'nonce',
  tag: 'tag',
});

function record(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    id: connectionId,
    workspaceId,
    providerKey: 'http',
    name: 'Operations API',
    authType: 'http_headers',
    status: 'active',
    currentSecretVersionId: secretVersionId,
    lastTestedAt: null,
    lastHealthyAt: null,
    lastErrorCode: null,
    createdBy: actorId,
    createdAt: new Date('2026-08-22T12:00:00.000Z'),
    updatedAt: new Date('2026-08-22T12:00:00.000Z'),
    ...overrides,
  };
}

function activeAccess() {
  return {
    actorId,
    workspaceId,
    role: 'owner' as const,
    membershipStatus: 'active' as const,
    workspaceStatus: 'active' as const,
  };
}

function persistence(overrides: Partial<ConnectionTestPersistence> = {}) {
  return {
    startConnectionTest: vi.fn<
      ConnectionTestPersistence['startConnectionTest']
    >(() =>
      Promise.resolve({
        kind: 'dispatch',
        dispatchToken: '11111111-1111-4111-8111-111111111111',
      }),
    ),
    resolveConnectionTestSecret: vi.fn<
      ConnectionTestPersistence['resolveConnectionTestSecret']
    >(() => Promise.resolve({ connection: record(), secretVersionId, sealed })),
    markConnectionTestDispatched: vi.fn<
      ConnectionTestPersistence['markConnectionTestDispatched']
    >(() => Promise.resolve()),
    completeConnectionTest: vi.fn<
      ConnectionTestPersistence['completeConnectionTest']
    >((input) =>
      Promise.resolve({ connection: record(), outcome: input.outcome }),
    ),
    abandonConnectionTest: vi.fn<
      ConnectionTestPersistence['abandonConnectionTest']
    >(() => Promise.resolve()),
    ...overrides,
  } satisfies ConnectionTestPersistence;
}

function command(request: unknown) {
  return {
    actor,
    routeWorkspaceId: workspaceId,
    connectionId,
    idempotencyKey: 'connection-test-regression',
    request,
  };
}

describe('connection testing security and cleanup regressions', () => {
  it('rejects an over-byte Unicode URL before reservation or credential work', async () => {
    const store = persistence();
    const open = vi.fn();
    const execute = vi.fn();
    const authorization = {
      findAccess: vi.fn().mockResolvedValue(activeAccess()),
    };

    await expect(
      new TestConnectionUseCase(
        store,
        authorization,
        { seal: vi.fn(), open },
        { execute },
      ).execute(
        command({
          url: `https://provider.example.test/${'😀'.repeat(700)}`,
        }),
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(authorization.findAccess).toHaveBeenCalledOnce();
    expect(store.startConnectionTest).not.toHaveBeenCalled();
    expect(store.resolveConnectionTestSecret).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['missing membership', undefined],
    [
      'inactive membership',
      { ...activeAccess(), membershipStatus: 'suspended' as const },
    ],
    ['downgraded membership', { ...activeAccess(), role: 'viewer' as const }],
    [
      'suspended workspace',
      { ...activeAccess(), workspaceStatus: 'suspended' as const },
    ],
  ] as const)(
    'abandons before credential egress when reauthorization sees %s',
    async (_name, deniedAccess) => {
      const store = persistence();
      const authorization = {
        findAccess: vi
          .fn()
          .mockResolvedValueOnce(activeAccess())
          .mockResolvedValueOnce(deniedAccess),
      };
      const open = vi.fn();
      const execute = vi.fn();

      await expect(
        new TestConnectionUseCase(
          store,
          authorization,
          { seal: vi.fn(), open },
          { execute },
        ).execute(command({ url: 'https://provider.example.test/health' })),
      ).rejects.toMatchObject({ code: 'resource.not_found' });
      expect(authorization.findAccess).toHaveBeenCalledTimes(2);
      expect(store.startConnectionTest).toHaveBeenCalledOnce();
      expect(store.resolveConnectionTestSecret).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(store.completeConnectionTest).not.toHaveBeenCalled();
      expect(store.abandonConnectionTest).toHaveBeenCalledOnce();
    },
  );

  it.each(['throws synchronously', 'rejects asynchronously'] as const)(
    'preserves provider failure and clears plaintext when abandonment $0',
    async (mode) => {
      const providerFailure = new Error('provider failed');
      const cleanupFailure = new Error('abandon failed');
      const plaintext = new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          type: 'http_headers',
          headers: { authorization: 'Bearer secret' },
        }),
      );
      const abandonConnectionTest = vi.fn<
        ConnectionTestPersistence['abandonConnectionTest']
      >(() => {
        if (mode === 'throws synchronously') throw cleanupFailure;
        return Promise.reject(cleanupFailure);
      });
      const store = persistence({ abandonConnectionTest });
      const authorization = {
        findAccess: vi.fn().mockResolvedValue(activeAccess()),
      };

      await expect(
        new TestConnectionUseCase(
          store,
          authorization,
          { seal: vi.fn(), open: vi.fn(() => Promise.resolve(plaintext)) },
          { execute: vi.fn(() => Promise.reject(providerFailure)) },
        ).execute(command({ url: 'https://provider.example.test/health' })),
      ).rejects.toBe(providerFailure);
      expect(abandonConnectionTest).toHaveBeenCalledOnce();
      expect(plaintext.every((byte) => byte === 0)).toBe(true);
    },
  );

  it('does not simulate network work after an awaited dispatch marker fails', async () => {
    const markerFailure = new Error('dispatch marker failed');
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        type: 'http_headers',
        headers: { authorization: 'Bearer secret' },
      }),
    );
    const store = persistence({
      markConnectionTestDispatched: vi.fn(() => Promise.reject(markerFailure)),
    });
    const networkAction = vi.fn();
    const execute = vi.fn(async (input: SecureHttpRequest) => {
      await input.beforeDispatch();
      networkAction();
      return {
        status: 204,
        headers: {},
        body: new Uint8Array(),
        bodyEncoding: 'utf8' as const,
        finalUrl: input.url,
        redirectCount: 0,
      };
    });

    await expect(
      new TestConnectionUseCase(
        store,
        { findAccess: vi.fn().mockResolvedValue(activeAccess()) },
        { seal: vi.fn(), open: vi.fn(() => Promise.resolve(plaintext)) },
        { execute },
      ).execute(command({ url: 'https://provider.example.test/health' })),
    ).rejects.toBe(markerFailure);
    expect(execute).toHaveBeenCalledOnce();
    expect(networkAction).not.toHaveBeenCalled();
    expect(store.completeConnectionTest).not.toHaveBeenCalled();
    expect(store.abandonConnectionTest).toHaveBeenCalledOnce();
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    {
      name: 'invalid UTF-8',
      request: { url: 'https://provider.example.test/health' },
      bytes: () => Uint8Array.from([0xff]),
      clients: 'http' as const,
    },
    {
      name: 'malformed JSON',
      request: { url: 'https://provider.example.test/health' },
      bytes: () => new TextEncoder().encode('{'),
      clients: 'http' as const,
    },
    {
      name: 'invalid credential fields',
      request: { providerKey: 'slack' },
      bytes: () =>
        new TextEncoder().encode(
          JSON.stringify({
            schemaVersion: 1,
            type: 'slack_bot_token',
            botToken: 'short',
          }),
        ),
      clients: 'slack' as const,
    },
    {
      name: 'HTTP credential on email route',
      request: {
        providerKey: 'email',
        sideEffectDisclosureAccepted: true,
      },
      bytes: () =>
        new TextEncoder().encode(
          JSON.stringify({
            schemaVersion: 1,
            type: 'http_headers',
            headers: { authorization: 'Bearer secret' },
          }),
        ),
      clients: 'email' as const,
    },
    {
      name: 'email credential without email client',
      request: {
        providerKey: 'email',
        sideEffectDisclosureAccepted: true,
      },
      bytes: () =>
        new TextEncoder().encode(
          JSON.stringify({
            schemaVersion: 1,
            type: 'resend_api_key',
            apiKey: 're_123456789_secret',
            fromEmail: 'sender@example.com',
          }),
        ),
      clients: 'none' as const,
    },
    {
      name: 'HTTP credential on Slack route',
      request: { providerKey: 'slack' },
      bytes: () =>
        new TextEncoder().encode(
          JSON.stringify({
            schemaVersion: 1,
            type: 'http_headers',
            headers: { authorization: 'Bearer secret' },
          }),
        ),
      clients: 'slack' as const,
    },
    {
      name: 'Slack credential without Slack client',
      request: { providerKey: 'slack' },
      bytes: () =>
        new TextEncoder().encode(
          JSON.stringify({
            schemaVersion: 1,
            type: 'slack_bot_token',
            botToken: 'xoxb-123456789-secret',
          }),
        ),
      clients: 'none' as const,
    },
    {
      name: 'Slack credential on HTTP route',
      request: { url: 'https://provider.example.test/health' },
      bytes: () =>
        new TextEncoder().encode(
          JSON.stringify({
            schemaVersion: 1,
            type: 'slack_bot_token',
            botToken: 'xoxb-123456789-secret',
          }),
        ),
      clients: 'http' as const,
    },
  ])(
    'rejects $name before provider dispatch',
    async ({ request, bytes, clients }) => {
      const plaintext = bytes();
      const execute = vi.fn();
      const authTest = vi.fn();
      const sendNotification = vi.fn();
      const store = persistence();
      const slackClient: Pick<ConnectionSlackClient, 'authTest'> | undefined =
        clients === 'slack' ? { authTest } : undefined;
      const emailClient: ConnectionEmailClient | undefined =
        clients === 'email' ? { sendNotification } : undefined;

      await expect(
        new TestConnectionUseCase(
          store,
          { findAccess: vi.fn().mockResolvedValue(activeAccess()) },
          { seal: vi.fn(), open: vi.fn(() => Promise.resolve(plaintext)) },
          { execute },
          undefined,
          slackClient,
          emailClient,
        ).execute(command(request)),
      ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);
      expect(execute).not.toHaveBeenCalled();
      expect(authTest).not.toHaveBeenCalled();
      expect(sendNotification).not.toHaveBeenCalled();
      expect(store.completeConnectionTest).not.toHaveBeenCalled();
      expect(store.abandonConnectionTest).toHaveBeenCalledOnce();
      expect(plaintext.every((byte) => byte === 0)).toBe(true);
    },
  );
});

describe('connection provider outcome projection', () => {
  it.each([
    [200, { ok: true, httpStatus: 200 }],
    [299, { ok: true, httpStatus: 299 }],
    [
      400,
      {
        ok: false,
        httpStatus: 400,
        errorCode: 'connection.provider_rejected',
        reauthorizationRequired: false,
      },
    ],
    [
      401,
      {
        ok: false,
        httpStatus: 401,
        errorCode: 'connection.credential_rejected',
        reauthorizationRequired: true,
      },
    ],
    [
      403,
      {
        ok: false,
        httpStatus: 403,
        errorCode: 'connection.credential_rejected',
        reauthorizationRequired: true,
      },
    ],
    [
      429,
      {
        ok: false,
        httpStatus: 429,
        errorCode: 'connection.provider_rate_limited',
        reauthorizationRequired: false,
      },
    ],
    [
      500,
      {
        ok: false,
        httpStatus: 500,
        errorCode: 'connection.provider_unavailable',
        reauthorizationRequired: false,
      },
    ],
  ] as const)(
    'persists exact HTTP status %i outcome',
    async (status, expected) => {
      const store = persistence();
      const plaintext = new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          type: 'http_headers',
          headers: { authorization: 'Bearer secret' },
        }),
      );
      const httpClient: ConnectionHttpClient = {
        execute: vi.fn(async (input: SecureHttpRequest) => {
          await input.beforeDispatch();
          return {
            status,
            headers: {},
            body: new Uint8Array(),
            bodyEncoding: 'utf8' as const,
            finalUrl: input.url,
            redirectCount: 0,
          };
        }),
      };

      const result = await new TestConnectionUseCase(
        store,
        { findAccess: vi.fn().mockResolvedValue(activeAccess()) },
        { seal: vi.fn(), open: vi.fn(() => Promise.resolve(plaintext)) },
        httpClient,
      ).execute(command({ url: 'https://provider.example.test/health' }));

      expect(store.completeConnectionTest).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: expected }),
      );
      expect(result.outcome).toEqual(
        expected.ok
          ? { ok: true, httpStatus: expected.httpStatus, errorCode: null }
          : {
              ok: false,
              httpStatus: expected.httpStatus,
              errorCode: expected.errorCode,
            },
      );
    },
  );

  it.each([
    ['success', { kind: 'succeeded' }, { ok: true, httpStatus: 200 }],
    [
      'account inactive',
      { kind: 'rejected', error: 'account_inactive' },
      {
        ok: false,
        httpStatus: 200,
        errorCode: 'connection.credential_rejected',
        reauthorizationRequired: true,
      },
    ],
    [
      'invalid auth',
      { kind: 'rejected', error: 'invalid_auth' },
      {
        ok: false,
        httpStatus: 200,
        errorCode: 'connection.credential_rejected',
        reauthorizationRequired: true,
      },
    ],
    [
      'not authed',
      { kind: 'rejected', error: 'not_authed' },
      {
        ok: false,
        httpStatus: 200,
        errorCode: 'connection.credential_rejected',
        reauthorizationRequired: true,
      },
    ],
    [
      'token revoked',
      { kind: 'rejected', error: 'token_revoked' },
      {
        ok: false,
        httpStatus: 200,
        errorCode: 'connection.credential_rejected',
        reauthorizationRequired: true,
      },
    ],
    [
      'provider rejection',
      { kind: 'rejected', error: 'team_disabled' },
      {
        ok: false,
        httpStatus: 200,
        errorCode: 'connection.provider_rejected',
        reauthorizationRequired: false,
      },
    ],
  ] as const)(
    'persists exact Slack $s outcome',
    async (_name, providerResult, expected) => {
      const slackRecord = record({
        providerKey: 'slack',
        authType: 'slack_bot_token',
      });
      const store = persistence({
        resolveConnectionTestSecret: vi.fn(() =>
          Promise.resolve({
            connection: slackRecord,
            secretVersionId,
            sealed,
          }),
        ),
      });
      const plaintext = new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          type: 'slack_bot_token',
          botToken: 'xoxb-123456789-secret',
        }),
      );
      const slackClient: Pick<ConnectionSlackClient, 'authTest'> = {
        authTest: vi.fn(
          async (input: Parameters<ConnectionSlackClient['authTest']>[0]) => {
            await input.beforeDispatch();
            return providerResult;
          },
        ),
      };

      const result = await new TestConnectionUseCase(
        store,
        { findAccess: vi.fn().mockResolvedValue(activeAccess()) },
        { seal: vi.fn(), open: vi.fn(() => Promise.resolve(plaintext)) },
        { execute: vi.fn() },
        undefined,
        slackClient,
      ).execute(command({ providerKey: 'slack' }));

      expect(store.completeConnectionTest).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: expected }),
      );
      expect(result.outcome.errorCode).toBe(
        expected.ok ? null : expected.errorCode,
      );
    },
  );

  it.each([
    [
      'success',
      { kind: 'succeeded', emailId: 'email-id' },
      { ok: true, httpStatus: 200 },
    ],
    [
      'credential rejection',
      { kind: 'rejected', status: 401, error: 'invalid_api_key' },
      {
        ok: false,
        httpStatus: 401,
        errorCode: 'connection.credential_rejected',
        reauthorizationRequired: true,
      },
    ],
    [
      'provider rejection',
      { kind: 'rejected', status: 400, error: 'invalid_request' },
      {
        ok: false,
        httpStatus: 400,
        errorCode: 'connection.provider_rejected',
        reauthorizationRequired: false,
      },
    ],
    [
      'rate limit',
      { kind: 'rate_limited', retryAfterMillis: 1_000 },
      {
        ok: false,
        httpStatus: 429,
        errorCode: 'connection.provider_rate_limited',
        reauthorizationRequired: false,
      },
    ],
    [
      'invalid response',
      { kind: 'invalid_response' },
      {
        ok: false,
        httpStatus: null,
        errorCode: 'connection.provider_invalid_response',
        reauthorizationRequired: false,
      },
    ],
  ] as const)(
    'persists exact email $s outcome',
    async (_name, providerResult, expected) => {
      const emailRecord = record({
        providerKey: 'email',
        authType: 'resend_api_key',
      });
      const store = persistence({
        resolveConnectionTestSecret: vi.fn(() =>
          Promise.resolve({
            connection: emailRecord,
            secretVersionId,
            sealed,
          }),
        ),
      });
      const plaintext = new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          type: 'resend_api_key',
          apiKey: 're_123456789_secret',
          fromEmail: 'sender@example.com',
        }),
      );
      const emailClient: ConnectionEmailClient = {
        sendNotification: vi.fn(
          async (
            input: Parameters<ConnectionEmailClient['sendNotification']>[0],
          ) => {
            await input.beforeDispatch();
            return providerResult;
          },
        ),
      };

      const result = await new TestConnectionUseCase(
        store,
        { findAccess: vi.fn().mockResolvedValue(activeAccess()) },
        { seal: vi.fn(), open: vi.fn(() => Promise.resolve(plaintext)) },
        { execute: vi.fn() },
        undefined,
        undefined,
        emailClient,
      ).execute(
        command({
          providerKey: 'email',
          sideEffectDisclosureAccepted: true,
        }),
      );

      expect(store.completeConnectionTest).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: expected }),
      );
      expect(result.outcome.errorCode).toBe(
        expected.ok ? null : expected.errorCode,
      );
    },
  );
});
