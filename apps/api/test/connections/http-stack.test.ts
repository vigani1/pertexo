import type {
  ConnectionRecord,
  FailureNotificationDestinationDatabase,
} from '@pertexo/database/testing';
import { connectionResponseSchema } from '@pertexo/contracts/connections';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApiApplication } from '../../src/app.js';
import type { ConnectionDependencies } from '../../src/connections/index.js';
import type { IdentityWorkspaceDependencies } from '../../src/identity-workspace/index.js';
import type { ApiConnectionRuntime } from '../../src/platform/connections/connection-runtime.module.js';
import type { ApiIdentityRuntime } from '../../src/platform/identity/identity-runtime.module.js';
import {
  createApiPlatformFixture,
  createStubApiWorkflowRuntime,
} from '../support/api-platform.fixture.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const rawSession = 's'.repeat(43);
const csrf = 'c'.repeat(32);
const credentialValue = 'Bearer http-stack-secret';
const destinationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const { config, database, logger, rateLimitConsumer, telemetry } =
  createApiPlatformFixture('0021_workflow_integration_usage.sql');

function identityRuntime(): ApiIdentityRuntime {
  const dependencies: IdentityWorkspaceDependencies = {
    config: {
      oidc: {
        issuer: 'https://identity.example.test',
        authorizationEndpoint: 'https://identity.example.test/authorize',
        clientId: 'client',
        redirectUri: 'https://api.example.test/v1/auth/oidc/callback',
        scopes: ['openid'],
        transactionTtlMillis: 300_000,
      },
    },
    provider: {
      authorizationUrl: () => 'https://identity.example.test/authorize',
      exchangeCode: () => Promise.reject(new Error('not used')),
    },
    transactions: {
      create: () => Promise.resolve(),
      consume: () => Promise.resolve({ status: 'missing' }),
    },
    persistence: {
      create: () => Promise.resolve(),
      findByDigest: () =>
        Promise.resolve({
          sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          tokenDigest: 'a'.repeat(64),
          userId: actorId,
          expiresAt: new Date(Date.now() + 60_000),
          clientMetadata: {},
        }),
      revokeByDigest: () => Promise.resolve(false),
      findUserById: () => Promise.resolve(null),
      listWorkspaceMembers: () => Promise.resolve({ items: [] }),
      resolveOrCreateIdentity: () => Promise.resolve({ userId: actorId }),
      createWorkspaceWithOwner: () => Promise.reject(new Error('not used')),
      requestWorkspaceLifecycleOperation: () =>
        Promise.reject(new Error('not used')),
      readWorkspaceLifecycleOperation: () =>
        Promise.reject(new Error('not used')),
    },
    authorization: {
      findAccess: (query: Readonly<{ actorId: string; workspaceId: string }>) =>
        Promise.resolve(
          query.actorId === actorId && query.workspaceId === workspaceId
            ? {
                actorId,
                workspaceId,
                role: 'owner' as const,
                membershipStatus: 'active' as const,
                workspaceStatus: 'active' as const,
              }
            : undefined,
        ),
    },
  };
  return Object.freeze({ dependencies, close: () => Promise.resolve() });
}

function connectionRuntime(
  authorization: IdentityWorkspaceDependencies['authorization'],
) {
  let stored: ConnectionRecord | null = null;
  let testResult:
    | Readonly<{
        connection: ConnectionRecord;
        outcome: Readonly<{ ok: true; httpStatus: number }>;
      }>
    | undefined;
  const createConnection = vi.fn(
    (
      input: Parameters<
        ConnectionDependencies['persistence']['createConnection']
      >[0],
    ) => {
      stored = {
        id: input.connectionId,
        workspaceId: input.workspaceId,
        providerKey: input.providerKey,
        name: input.name,
        authType: input.authType,
        status: 'active',
        currentSecretVersionId: input.secretVersionId,
        lastTestedAt: null,
        lastHealthyAt: null,
        lastErrorCode: null,
        createdBy: input.actorId,
        createdAt: new Date('2026-08-22T12:00:00.000Z'),
        updatedAt: new Date('2026-08-22T12:00:00.000Z'),
      };
      return Promise.resolve(stored);
    },
  );
  const encryption = {
    seal: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      kmsKeyReference: 'alias/pertexo-connections',
      encryptedDataKey: 'encrypted-key',
      ciphertext: 'ciphertext',
      nonce: 'nonce',
      tag: 'tag',
    }),
    open: vi.fn(() =>
      Promise.resolve(
        new TextEncoder().encode(
          JSON.stringify({
            schemaVersion: 1,
            type: 'http_headers',
            headers: { authorization: credentialValue },
          }),
        ),
      ),
    ),
  };
  const markConnectionTestDispatched = vi.fn(() => Promise.resolve());
  const destinationRecord = {
    id: destinationId,
    workspaceId,
    kind: 'slack' as const,
    status: 'enabled' as const,
    currentVersion: 2,
    config: {
      kind: 'slack' as const,
      connectionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      channelId: 'C67890',
    },
    createdAt: new Date('2026-08-22T12:00:00.000Z'),
    updatedAt: new Date('2026-08-22T12:01:00.000Z'),
  };
  const appendDestinationVersion = vi
    .fn<FailureNotificationDestinationDatabase['appendVersion']>()
    .mockResolvedValue(destinationRecord);
  const destinationPersistence: FailureNotificationDestinationDatabase = {
    create: () => Promise.reject(new Error('not used')),
    get: () => Promise.resolve(destinationRecord),
    list: () => Promise.resolve([destinationRecord]),
    appendVersion: appendDestinationVersion,
    setStatus: () => Promise.reject(new Error('not used')),
    setWorkflowPolicy: () => Promise.reject(new Error('not used')),
    clearWorkflowPolicy: () => Promise.reject(new Error('not used')),
    close: () => Promise.resolve(),
  };
  const executeHttp = vi.fn<ConnectionDependencies['httpClient']['execute']>(
    async (input) => {
      expect(input.headers).toEqual({ authorization: credentialValue });
      await input.beforeDispatch();
      return {
        status: 204,
        headers: {},
        body: new Uint8Array(),
        bodyEncoding: 'utf8' as const,
        finalUrl: 'https://provider.example.test',
        redirectCount: 0,
      };
    },
  );
  const runtime: ApiConnectionRuntime = Object.freeze({
    dependencies: {
      authorization,
      encryption,
      httpClient: {
        execute: executeHttp,
      },
      persistence: {
        createConnection,
        findConnectionCreateReplay: () => Promise.resolve(stored),
        findConnectionRotateReplay: () => Promise.resolve(null),
        rotateConnectionSecret: () => Promise.reject(new Error('not used')),
        revokeConnection: () => Promise.reject(new Error('not used')),
        startConnectionTest: (
          input: Parameters<
            ConnectionDependencies['persistence']['startConnectionTest']
          >[0],
        ) => {
          if (testResult !== undefined)
            return Promise.resolve({
              kind: 'replay' as const,
              result: testResult,
            });
          if (stored === null) return Promise.reject(new Error('not created'));
          return Promise.resolve({
            kind: 'dispatch' as const,
            dispatchToken: input.dispatchToken,
          });
        },
        resolveConnectionTestSecret: () => {
          if (stored === null) return Promise.reject(new Error('not created'));
          return Promise.resolve({
            connection: stored,
            secretVersionId: stored.currentSecretVersionId,
            sealed: {
              schemaVersion: 1 as const,
              kmsKeyReference: 'alias/pertexo-connections',
              encryptedDataKey: 'encrypted-key',
              ciphertext: 'ciphertext',
              nonce: 'nonce',
              tag: 'tag',
            },
          });
        },
        markConnectionTestDispatched,
        completeConnectionTest: (
          input: Parameters<
            ConnectionDependencies['persistence']['completeConnectionTest']
          >[0],
        ) => {
          if (stored === null || !input.outcome.ok)
            return Promise.reject(new Error('unexpected test outcome'));
          stored = {
            ...stored,
            lastTestedAt: new Date('2026-08-22T12:01:00.000Z'),
            lastHealthyAt: new Date('2026-08-22T12:01:00.000Z'),
            updatedAt: new Date('2026-08-22T12:01:00.000Z'),
          };
          testResult = { connection: stored, outcome: input.outcome };
          return Promise.resolve(testResult);
        },
        abandonConnectionTest: () => Promise.resolve(),
      },
      destinationPersistence,
    },
    close: () => Promise.resolve(),
  });
  return {
    runtime,
    createConnection,
    encryption,
    executeHttp,
    markConnectionTestDispatched,
    appendDestinationVersion,
  };
}

describe('connections real Nest HTTP stack', () => {
  let application: Awaited<ReturnType<typeof createApiApplication>> | undefined;

  afterEach(async () => {
    await application?.close();
    application = undefined;
  });

  it('enforces auth/CSRF, creates once, replays safely, and never returns secrets', async () => {
    const identity = identityRuntime();
    const connection = connectionRuntime(identity.dependencies.authorization);
    application = await createApiApplication(config, {
      database,
      identityRuntime: identity,
      workflowRuntime: createStubApiWorkflowRuntime(
        identity.dependencies.authorization,
      ),
      connectionRuntime: connection.runtime,
      logger,
      rateLimitConsumer,
      telemetry,
    });
    await application.init();
    const url = `/v1/workspaces/${workspaceId}/connections`;
    const payload = {
      providerKey: 'http',
      name: 'Operations API',
      credential: {
        schemaVersion: 1,
        type: 'http_headers',
        headers: { Authorization: credentialValue },
      },
    };

    const unauthenticated = await application.inject({
      method: 'POST',
      url,
      headers: { 'idempotency-key': 'create-http-stack' },
      payload,
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({
      code: 'auth.unauthenticated',
    });

    const headers = {
      cookie: `pertexo_session=${rawSession}; pertexo_csrf=${csrf}`,
      'x-csrf-token': csrf,
      'idempotency-key': 'create-http-stack',
    };
    const created = await application.inject({
      method: 'POST',
      url,
      headers,
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      workspaceId,
      providerKey: 'http',
      authType: 'http_headers',
      status: 'active',
    });
    expect(created.payload).not.toContain(credentialValue);
    expect(created.payload).not.toContain('credential');

    const replay = await application.inject({
      method: 'POST',
      url,
      headers,
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(created.json());
    expect(connection.createConnection).toHaveBeenCalledOnce();
    expect(connection.encryption.seal).toHaveBeenCalledOnce();

    const connectionId = connectionResponseSchema.parse(created.json()).id;
    const testHeaders = { ...headers, 'idempotency-key': 'test-http-stack' };
    const tested = await application.inject({
      method: 'POST',
      url: `${url}/${connectionId}/test`,
      headers: testHeaders,
      payload: { url: 'https://provider.example.test/health' },
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({
      connection: { id: connectionId, status: 'active' },
      outcome: { ok: true, httpStatus: 204, errorCode: null },
    });
    expect(tested.payload).not.toContain(credentialValue);
    const testReplay = await application.inject({
      method: 'POST',
      url: `${url}/${connectionId}/test`,
      headers: testHeaders,
      payload: { url: 'https://provider.example.test/health' },
    });
    expect(testReplay.statusCode).toBe(200);
    expect(testReplay.json()).toEqual(tested.json());
    expect(connection.executeHttp).toHaveBeenCalledOnce();
    expect(connection.encryption.open).toHaveBeenCalledOnce();
    expect(connection.markConnectionTestDispatched).toHaveBeenCalledOnce();

    const destinationPath = `/v1/workspaces/${workspaceId}/failure-notification-destinations/${destinationId}/versions`;
    const unauthenticatedDestination = await application.inject({
      method: 'POST',
      url: destinationPath,
      payload: {
        expectedVersion: 1,
        config: {
          kind: 'slack',
          connectionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          channelId: 'C67890',
        },
      },
    });
    expect(unauthenticatedDestination.statusCode).toBe(401);
    const forbiddenDestination = await application.inject({
      method: 'POST',
      url: destinationPath.replace(
        workspaceId,
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
      ),
      headers: { ...headers, 'idempotency-key': 'destination-hidden-wire' },
      payload: {
        expectedVersion: 1,
        config: {
          kind: 'slack',
          connectionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          channelId: 'C67890',
        },
      },
    });
    expect(forbiddenDestination.statusCode).toBe(404);
    expect(connection.appendDestinationVersion).not.toHaveBeenCalled();

    const appended = await application.inject({
      method: 'POST',
      url: destinationPath,
      headers: { ...headers, 'idempotency-key': 'destination-append-wire' },
      payload: {
        expectedVersion: 1,
        config: {
          kind: 'slack',
          connectionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          channelId: 'C67890',
        },
      },
    });
    expect(appended.statusCode).toBe(200);
    expect(appended.json()).toMatchObject({
      id: destinationId,
      currentVersion: 2,
    });
    expect(connection.appendDestinationVersion).toHaveBeenCalledOnce();
  });
});
