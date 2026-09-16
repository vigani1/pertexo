import type {
  ConnectionRecord,
  FailureNotificationDestinationDatabase,
} from '@pertexo/database/testing';
import { FailureNotificationDestinationError } from '@pertexo/database/api';
import { connectionResponseSchema } from '@pertexo/contracts/connections';
import {
  ConnectionSecretEncryptionError,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
} from '@pertexo/integrations/server';
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

function identityRuntime(
  role: 'admin' | 'builder' | 'owner' | 'viewer' = 'owner',
): ApiIdentityRuntime {
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
          expiresAt: new Date('2099-08-22T20:00:00.000Z'),
          clientMetadata: {},
        }),
      revokeByDigest: () => Promise.resolve(false),
      findUserById: () => Promise.resolve(null),
      listAccessibleWorkspaces: () => Promise.resolve({ items: [] }),
      listWorkspaceMembers: () => Promise.resolve({ items: [] }),
      changeWorkspaceMemberRole: () => Promise.reject(new Error('not used')),
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
                role,
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
  let createReplayIdentity:
    | Readonly<{
        workspaceId: string;
        actorId: string;
        idempotencyKey: string;
        requestHash: string;
      }>
    | undefined;
  let testReplayIdentity:
    | Readonly<{
        workspaceId: string;
        actorId: string;
        connectionId: string;
        idempotencyKey: string;
        requestHash: string;
      }>
    | undefined;
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
      createReplayIdentity = {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      };
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
  const getDestination = vi
    .fn<FailureNotificationDestinationDatabase['get']>()
    .mockResolvedValue(destinationRecord);
  const listDestinations = vi
    .fn<FailureNotificationDestinationDatabase['list']>()
    .mockResolvedValue([destinationRecord]);
  const destinationPersistence: FailureNotificationDestinationDatabase = {
    create: () => Promise.reject(new Error('not used')),
    get: getDestination,
    list: listDestinations,
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
        listConnections: () =>
          Promise.resolve({ items: stored === null ? [] : [stored] }),
        readConnection: (input) =>
          Promise.resolve(
            stored?.workspaceId === input.workspaceId &&
              stored.id === input.connectionId
              ? stored
              : null,
          ),
        createConnection,
        findConnectionCreateReplay: (input) =>
          Promise.resolve(
            stored !== null &&
              createReplayIdentity !== undefined &&
              replayIdentityMatches(createReplayIdentity, input)
              ? stored
              : null,
          ),
        findConnectionRotateReplay: () => Promise.resolve(null),
        rotateConnectionSecret: () => Promise.reject(new Error('not used')),
        revokeConnection: () => Promise.reject(new Error('not used')),
        startConnectionTest: (
          input: Parameters<
            ConnectionDependencies['persistence']['startConnectionTest']
          >[0],
        ) => {
          if (testResult !== undefined) {
            if (
              testReplayIdentity === undefined ||
              !replayIdentityMatches(testReplayIdentity, input)
            )
              return Promise.reject(
                new Error('test replay identity does not match'),
              );
            return Promise.resolve({
              kind: 'replay' as const,
              result: testResult,
            });
          }
          if (stored === null) return Promise.reject(new Error('not created'));
          testReplayIdentity = {
            workspaceId: input.workspaceId,
            actorId: input.actorId,
            connectionId: input.connectionId,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
          };
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
    getDestination,
    listDestinations,
  };
}

function replayIdentityMatches(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, unknown>>,
): boolean {
  return Object.entries(expected).every(
    ([name, value]) => actual[name] === value,
  );
}

const connectionUrl = `/v1/workspaces/${workspaceId}/connections`;
const connectionPayload = {
  providerKey: 'http',
  name: 'Operations API',
  credential: {
    schemaVersion: 1,
    type: 'http_headers',
    headers: { Authorization: credentialValue },
  },
} as const;
const authenticatedHeaders = {
  cookie: `pertexo_session=${rawSession}; pertexo_csrf=${csrf}`,
  'x-csrf-token': csrf,
  'idempotency-key': 'create-http-stack',
};
const destinationPath = `/v1/workspaces/${workspaceId}/failure-notification-destinations/${destinationId}/versions`;
const destinationPayload = {
  expectedVersion: 1,
  config: {
    kind: 'slack',
    connectionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    channelId: 'C67890',
  },
} as const;

describe('connections real Nest HTTP stack', () => {
  let application: Awaited<ReturnType<typeof createApiApplication>> | undefined;

  async function start(
    role: 'admin' | 'builder' | 'owner' | 'viewer' = 'owner',
  ) {
    const identity = identityRuntime(role);
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
    return { application, connection };
  }

  afterEach(async () => {
    await application?.close();
    application = undefined;
  });

  it('rejects unauthenticated and invalid-CSRF mutations before persistence or encryption', async () => {
    const { application, connection } = await start();
    const unauthenticated = await application.inject({
      method: 'POST',
      url: connectionUrl,
      headers: { 'idempotency-key': 'create-http-stack' },
      payload: connectionPayload,
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({
      code: 'auth.unauthenticated',
    });

    const missingCsrf = await application.inject({
      method: 'POST',
      url: connectionUrl,
      headers: {
        cookie: `pertexo_session=${rawSession}; pertexo_csrf=${csrf}`,
        'idempotency-key': 'create-http-stack',
      },
      payload: connectionPayload,
    });
    expect(missingCsrf.statusCode).toBe(403);

    const mismatchedCsrf = await application.inject({
      method: 'POST',
      url: connectionUrl,
      headers: {
        cookie: `pertexo_session=${rawSession}; pertexo_csrf=${csrf}`,
        'x-csrf-token': 'x'.repeat(32),
        'idempotency-key': 'create-http-stack',
      },
      payload: connectionPayload,
    });
    expect(mismatchedCsrf.statusCode).toBe(403);
    expect(connection.createConnection).not.toHaveBeenCalled();
    expect(connection.encryption.seal).not.toHaveBeenCalled();
  });

  it('creates and tests a connection once, replays only the same input, and omits secrets', async () => {
    const { application, connection } = await start();
    const created = await application.inject({
      method: 'POST',
      url: connectionUrl,
      headers: authenticatedHeaders,
      payload: connectionPayload,
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

    const connectionId = connectionResponseSchema.parse(created.json()).id;
    const listed = await application.inject({
      method: 'GET',
      url: `${connectionUrl}?limit=1`,
      headers: authenticatedHeaders,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      items: [expect.objectContaining({ id: connectionId })],
      nextCursor: null,
    });
    const read = await application.inject({
      method: 'GET',
      url: `${connectionUrl}/${connectionId}`,
      headers: authenticatedHeaders,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ id: connectionId, workspaceId });
    expect(`${listed.payload}${read.payload}`).not.toContain(credentialValue);

    const replay = await application.inject({
      method: 'POST',
      url: connectionUrl,
      headers: authenticatedHeaders,
      payload: connectionPayload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(created.json());
    expect(connection.createConnection).toHaveBeenCalledOnce();
    expect(connection.encryption.seal).toHaveBeenCalledOnce();

    const testHeaders = {
      ...authenticatedHeaders,
      'idempotency-key': 'test-http-stack',
    };
    const testPayload = { url: 'https://provider.example.test/health' };
    const tested = await application.inject({
      method: 'POST',
      url: `${connectionUrl}/${connectionId}/test`,
      headers: testHeaders,
      payload: testPayload,
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({
      connection: { id: connectionId, status: 'active' },
      outcome: { ok: true, httpStatus: 204, errorCode: null },
    });
    expect(tested.payload).not.toContain(credentialValue);
    const testReplay = await application.inject({
      method: 'POST',
      url: `${connectionUrl}/${connectionId}/test`,
      headers: testHeaders,
      payload: testPayload,
    });
    expect(testReplay.statusCode).toBe(200);
    expect(testReplay.json()).toEqual(tested.json());
    expect(connection.executeHttp).toHaveBeenCalledOnce();
    expect(connection.encryption.open).toHaveBeenCalledOnce();
    expect(connection.markConnectionTestDispatched).toHaveBeenCalledOnce();
  });

  it('hides unauthenticated and cross-workspace destination mutations', async () => {
    const { application, connection } = await start();
    const unauthenticated = await application.inject({
      method: 'POST',
      url: destinationPath,
      payload: destinationPayload,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const crossWorkspace = await application.inject({
      method: 'POST',
      url: destinationPath.replace(
        workspaceId,
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
      ),
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'destination-hidden-wire',
      },
      payload: destinationPayload,
    });
    expect(crossWorkspace.statusCode).toBe(404);
    expect(connection.appendDestinationVersion).not.toHaveBeenCalled();
  });

  it('allows a builder to read destinations but denies destination management', async () => {
    const { application, connection } = await start('builder');
    const listed = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/failure-notification-destinations`,
      headers: authenticatedHeaders,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      items: [
        expect.objectContaining({ id: destinationId, currentVersion: 2 }),
      ],
    });
    expect(connection.listDestinations).toHaveBeenCalledOnce();

    const denied = await application.inject({
      method: 'POST',
      url: destinationPath,
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'destination-builder-denied',
      },
      payload: destinationPayload,
    });
    expect(denied.statusCode).toBe(404);
    expect(connection.appendDestinationVersion).not.toHaveBeenCalled();
  });

  it('denies a viewer destination reads before persistence', async () => {
    const { application, connection } = await start('viewer');
    const denied = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/failure-notification-destinations`,
      headers: authenticatedHeaders,
    });
    expect(denied.statusCode).toBe(404);
    expect(connection.listDestinations).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'] as const)(
    'allows a %s to append a destination version',
    async (role) => {
      const { application, connection } = await start(role);
      const appended = await application.inject({
        method: 'POST',
        url: destinationPath,
        headers: {
          ...authenticatedHeaders,
          'idempotency-key': `destination-${role}-append`,
        },
        payload: destinationPayload,
      });
      expect(appended.statusCode).toBe(200);
      expect(appended.json()).toMatchObject({
        id: destinationId,
        currentVersion: 2,
      });
      expect(connection.appendDestinationVersion).toHaveBeenCalledOnce();
    },
  );

  it('maps hidden destination reads and conflicts to public HTTP errors', async () => {
    const { application, connection } = await start();
    connection.getDestination.mockRejectedValueOnce(
      new FailureNotificationDestinationError(
        'not_found',
        'raw hidden destination detail',
      ),
    );
    const hidden = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/failure-notification-destinations/${destinationId}`,
      headers: authenticatedHeaders,
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ code: 'resource.not_found' });
    expect(hidden.payload).not.toContain('raw hidden destination detail');

    connection.appendDestinationVersion.mockRejectedValueOnce(
      new FailureNotificationDestinationError(
        'conflict',
        'raw destination version detail',
      ),
    );
    const conflict = await application.inject({
      method: 'POST',
      url: destinationPath,
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'destination-conflict-wire',
      },
      payload: destinationPayload,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'connection.conflict' });
    expect(conflict.payload).not.toContain('raw destination version detail');
  });

  it('does not serialize raw credential-protection causes', async () => {
    const { application, connection } = await start();
    const failure = new ConnectionSecretEncryptionError();
    Object.defineProperty(failure, 'cause', {
      value: new Error('Bearer raw-kms-credential'),
    });
    connection.encryption.seal.mockRejectedValueOnce(failure);
    const response = await application.inject({
      method: 'POST',
      url: connectionUrl,
      headers: authenticatedHeaders,
      payload: connectionPayload,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'provider.unavailable' });
    expect(response.payload).not.toContain('raw-kms-credential');
    expect(response.payload).not.toContain(credentialValue);
  });

  it('does not serialize raw provider failure causes', async () => {
    const { application, connection } = await start();
    const created = await application.inject({
      method: 'POST',
      url: connectionUrl,
      headers: authenticatedHeaders,
      payload: connectionPayload,
    });
    const connectionId = connectionResponseSchema.parse(created.json()).id;
    const providerFailure = new SecureHttpError(
      SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed,
      'definite_failure',
      false,
    );
    Object.defineProperty(providerFailure, 'cause', {
      value: new Error('provider body with raw-secret'),
    });
    connection.executeHttp.mockRejectedValueOnce(providerFailure);
    const response = await application.inject({
      method: 'POST',
      url: `${connectionUrl}/${connectionId}/test`,
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'test-provider-cause',
      },
      payload: { url: 'https://provider.example.test/health' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'provider.unavailable' });
    expect(response.payload).not.toContain('provider body with raw-secret');
    expect(response.payload).not.toContain(credentialValue);
  });
});
