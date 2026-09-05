import type { ConnectionRecord } from '@pertexo/database/testing';
import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  type SecureHttpRequest,
} from '@pertexo/integrations/server';
import { describe, expect, it, vi } from 'vitest';

import type {
  ConnectionCommandPersistence,
  ConnectionHttpClient,
  ConnectionEmailClient,
  ConnectionSlackClient,
  ConnectionTestPersistence,
} from '../../src/connections/ports.js';
import {
  CreateConnectionUseCase,
  RevokeConnectionUseCase,
  RotateConnectionSecretUseCase,
  TestConnectionUseCase,
} from '../../src/connections/use-cases.js';
import {
  authorizeWorkspace,
  createActorContext,
} from '../../src/workspaces/index.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const secretVersionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const nextSecretVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const credential = {
  schemaVersion: 1,
  type: 'http_headers',
  headers: { Authorization: 'Bearer deeply-secret-value' },
} as const;
const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  requestId: 'request-42',
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

function authorization() {
  return {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role: 'owner' as const,
      membershipStatus: 'active' as const,
      workspaceStatus: 'active' as const,
    }),
  };
}

function persistence(overrides: Partial<ConnectionCommandPersistence> = {}) {
  return {
    createConnection: vi.fn<ConnectionCommandPersistence['createConnection']>(
      () => Promise.resolve(record()),
    ),
    findConnectionCreateReplay: vi.fn<
      ConnectionCommandPersistence['findConnectionCreateReplay']
    >(() => Promise.resolve(null)),
    findConnectionRotateReplay: vi.fn<
      ConnectionCommandPersistence['findConnectionRotateReplay']
    >(() => Promise.resolve(null)),
    rotateConnectionSecret: vi.fn<
      ConnectionCommandPersistence['rotateConnectionSecret']
    >(() =>
      Promise.resolve(record({ currentSecretVersionId: nextSecretVersionId })),
    ),
    revokeConnection: vi.fn<ConnectionCommandPersistence['revokeConnection']>(
      () => Promise.resolve(record({ status: 'revoked' })),
    ),
    ...overrides,
  } satisfies ConnectionCommandPersistence;
}

function testPersistence(overrides: Partial<ConnectionTestPersistence> = {}) {
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
    >(() =>
      Promise.resolve({
        connection: record(),
        secretVersionId,
        sealed,
      }),
    ),
    markConnectionTestDispatched: vi.fn<
      ConnectionTestPersistence['markConnectionTestDispatched']
    >(() => Promise.resolve()),
    completeConnectionTest: vi.fn<
      ConnectionTestPersistence['completeConnectionTest']
    >((input) =>
      Promise.resolve({
        connection: record({
          lastTestedAt: new Date('2026-08-22T12:01:00.000Z'),
          ...(input.outcome.ok
            ? { lastHealthyAt: new Date('2026-08-22T12:01:00.000Z') }
            : { lastErrorCode: input.outcome.errorCode }),
        }),
        outcome: input.outcome,
      }),
    ),
    abandonConnectionTest: vi.fn<
      ConnectionTestPersistence['abandonConnectionTest']
    >(() => Promise.resolve()),
    ...overrides,
  } satisfies ConnectionTestPersistence;
}

const sealed = Object.freeze({
  schemaVersion: 1 as const,
  kmsKeyReference: 'alias/pertexo-connections',
  encryptedDataKey: 'encrypted-key',
  ciphertext: 'ciphertext',
  nonce: 'nonce',
  tag: 'tag',
});

describe('connection application use cases', () => {
  it('rejects invalid unknown command bodies at the use-case boundary', async () => {
    const store = persistence();
    const encryption = { seal: vi.fn() };
    await expect(
      new CreateConnectionUseCase(store, authorization(), encryption).execute({
        actor,
        routeWorkspaceId: workspaceId,
        idempotencyKey: 'create-invalid',
        request: {
          providerKey: 'http',
          name: 'Operations API',
          credential: {
            schemaVersion: 1,
            type: 'http_headers',
            headers: { Host: 'metadata.internal' },
          },
        },
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(encryption.seal).not.toHaveBeenCalled();

    await expect(
      new TestConnectionUseCase(
        testPersistence(),
        authorization(),
        { open: vi.fn(), seal: vi.fn() },
        { execute: vi.fn() },
      ).execute({
        actor,
        routeWorkspaceId: workspaceId,
        connectionId,
        idempotencyKey: 'test-invalid',
        request: { url: 'http://provider.example.test/health' },
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('reuses guard authorization without repeating a command access lookup', async () => {
    const access = authorization();
    const authorizedWorkspace = await authorizeWorkspace({
      actor,
      routeWorkspaceId: workspaceId,
      capability: 'connection:manage',
      access,
      disclosure: 'not_found',
    });

    await new RevokeConnectionUseCase(persistence(), access).execute({
      actor,
      routeWorkspaceId: workspaceId,
      authorizedWorkspace,
      connectionId,
    });

    expect(access.findAccess).toHaveBeenCalledTimes(1);
  });

  it('authorizes, seals, persists, zeroes plaintext, and returns no credential material', async () => {
    const createConnection = vi.fn<
      ConnectionCommandPersistence['createConnection']
    >(() => Promise.resolve(record()));
    const store = persistence({ createConnection });
    let plaintext: Uint8Array | undefined;
    const encryption = {
      seal: vi.fn().mockImplementation((value: Uint8Array) => {
        plaintext = value;
        expect(new TextDecoder().decode(value)).toContain(
          'deeply-secret-value',
        );
        return Promise.resolve(sealed);
      }),
    };
    const signal = new AbortController().signal;
    const result = await new CreateConnectionUseCase(
      store,
      authorization(),
      encryption,
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      idempotencyKey: 'create-42',
      requestId: 'request-42',
      request: { providerKey: 'http', name: 'Operations API', credential },
      signal,
    });

    expect(encryption.seal).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ workspaceId }),
      signal,
    );
    expect(createConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        actorId,
        authType: 'http_headers',
        idempotencyKey: 'create-42',
        sealed,
      }),
    );
    expect(createConnection.mock.calls[0]?.[0].requestHash).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(plaintext).toBeDefined();
    expect(plaintext?.every((byte) => byte === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('deeply-secret-value');
    expect(result).not.toHaveProperty('credential');
  });

  it('does not persist a connection when cancellation races KMS completion', async () => {
    const controller = new AbortController();
    let plaintext: Uint8Array | undefined;
    const store = persistence();
    const encryption = {
      seal: vi.fn((value: Uint8Array) => {
        plaintext = value;
        controller.abort();
        return Promise.resolve(sealed);
      }),
    };

    await expect(
      new CreateConnectionUseCase(
        store,
        authorization(),
        encryption,
      ).execute({
        actor,
        routeWorkspaceId: workspaceId,
        idempotencyKey: 'create-canceled',
        request: { providerKey: 'http', name: 'Operations API', credential },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.createConnection).not.toHaveBeenCalled();
    expect(plaintext?.every((byte) => byte === 0)).toBe(true);
  });

  it('returns an exact create replay without generating IDs or contacting KMS', async () => {
    const store = persistence({
      findConnectionCreateReplay: vi.fn().mockResolvedValue(record()),
    });
    const encryption = {
      seal: vi.fn().mockRejectedValue(new Error('KMS down')),
    };

    const result = await new CreateConnectionUseCase(
      store,
      authorization(),
      encryption,
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      idempotencyKey: 'create-replay',
      request: { providerKey: 'http', name: 'Operations API', credential },
    });

    expect(result.id).toBe(connectionId);
    expect(encryption.seal).not.toHaveBeenCalled();
    expect(store.createConnection).not.toHaveBeenCalled();
  });

  it('returns an exact rotation replay without contacting KMS', async () => {
    const store = persistence({
      findConnectionRotateReplay: vi
        .fn()
        .mockResolvedValue(
          record({ currentSecretVersionId: nextSecretVersionId }),
        ),
    });
    const encryption = {
      seal: vi.fn().mockRejectedValue(new Error('KMS down')),
    };

    const result = await new RotateConnectionSecretUseCase(
      store,
      authorization(),
      encryption,
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      connectionId,
      idempotencyKey: 'rotate-replay',
      request: { expectedSecretVersionId: secretVersionId, credential },
    });

    expect(result.secretVersionId).toBe(nextSecretVersionId);
    expect(encryption.seal).not.toHaveBeenCalled();
    expect(store.rotateConnectionSecret).not.toHaveBeenCalled();
  });

  it('rotates through CAS/idempotency inputs and revokes through the same authorization seam', async () => {
    const rotateConnectionSecret = vi.fn<
      ConnectionCommandPersistence['rotateConnectionSecret']
    >(() =>
      Promise.resolve(record({ currentSecretVersionId: nextSecretVersionId })),
    );
    const revokeConnection = vi.fn<
      ConnectionCommandPersistence['revokeConnection']
    >(() => Promise.resolve(record({ status: 'revoked' })));
    const store = persistence({ rotateConnectionSecret, revokeConnection });
    let plaintext: Uint8Array | undefined;
    const encryption = {
      seal: vi.fn((value: Uint8Array) => {
        plaintext = value;
        return Promise.resolve(sealed);
      }),
    };

    const rotated = await new RotateConnectionSecretUseCase(
      store,
      authorization(),
      encryption,
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      connectionId,
      idempotencyKey: 'rotate-42',
      request: { expectedSecretVersionId: secretVersionId, credential },
    });
    expect(rotated.secretVersionId).toBe(nextSecretVersionId);
    expect(rotateConnectionSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId,
        expectedCurrentSecretVersionId: secretVersionId,
        idempotencyKey: 'rotate-42',
      }),
    );
    expect(plaintext?.every((byte) => byte === 0)).toBe(true);

    const revoked = await new RevokeConnectionUseCase(
      store,
      authorization(),
    ).execute({ actor, routeWorkspaceId: workspaceId, connectionId });
    expect(revoked.status).toBe('revoked');
    expect(revokeConnection).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, actorId, connectionId }),
    );
  });

  it('hides a route-workspace mismatch before persistence or encryption', async () => {
    const store = persistence();
    const encryption = { seal: vi.fn() };

    await expect(
      new CreateConnectionUseCase(store, authorization(), encryption).execute({
        actor,
        routeWorkspaceId: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: 'create-42',
        request: { providerKey: 'http', name: 'Operations API', credential },
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(store.findConnectionCreateReplay).not.toHaveBeenCalled();
    expect(encryption.seal).not.toHaveBeenCalled();
  });

  it('decrypts just in time, commits dispatch evidence, and stores only a safe test result', async () => {
    const store = testPersistence();
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
    const store = testPersistence({
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
    const store = testPersistence({
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
    const emailRecord = record({
      providerKey: 'email',
      authType: 'resend_api_key',
      name: 'Transactional email',
    });
    const store = testPersistence({
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
      }),
    ).resolves.toMatchObject({ outcome: { ok: true, httpStatus: 200 } });
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(store.markConnectionTestDispatched).toHaveBeenCalledOnce();
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    { providerKey: 'email' },
    { providerKey: 'email', sideEffectDisclosureAccepted: false },
  ])(
    'rejects email test disclosure %j before claim, secret open, or dispatch',
    async (request) => {
      const store = testPersistence();
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
    const store = testPersistence();
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
    const securityStore = testPersistence();
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

    const markerStore = testPersistence();
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
});
