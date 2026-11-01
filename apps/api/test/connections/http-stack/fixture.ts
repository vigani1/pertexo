import type { Role } from '@pertexo/workflow-model';
import type {
  ConnectionRecord,
  FailureNotificationDestinationDatabase,
} from '@pertexo/core/testing';

import { expect, vi } from 'vitest';
import { createTestApiApplication } from '../../support/api-application.js';
import type { ConnectionDependencies } from '../../../src/connections/index.js';
import type { IdentityWorkspaceDependencies } from '../../../src/workspaces/index.js';
import type { ApiConnectionRuntime } from '../../../src/platform/connections/runtime.module.js';
import type { ApiIdentityRuntime } from '../../../src/platform/identity/runtime.module.js';
import {
  createApiPlatformFixture,
  createStubIdentityRuntime,
  createStubApiWorkflowRuntime,
} from '../../support/api-platform.fixture.js';

export const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const rawSession = 's'.repeat(43);

export const csrf = 'c'.repeat(32);

export const credentialValue = 'Bearer http-stack-secret';

export const destinationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const { config, database, logger, rateLimitConsumer, telemetry } =
  createApiPlatformFixture('0021_workflow_integration_usage.sql');

export function identityRuntime(role: Role = 'owner'): ApiIdentityRuntime {
  return createStubIdentityRuntime(actorId, {
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
  });
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
        accessMode: 'workspace',
      };
      return Promise.resolve(stored);
    },
  );
  const encryption = {
    seal: vi.fn().mockResolvedValue({
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
  const getWorkflowPolicy = vi
    .fn<FailureNotificationDestinationDatabase['getWorkflowPolicy']>()
    .mockResolvedValue(destinationRecord);
  const destinationPersistence: FailureNotificationDestinationDatabase = {
    create: () => Promise.reject(new Error('not used')),
    get: getDestination,
    list: listDestinations,
    appendVersion: appendDestinationVersion,
    setStatus: () => Promise.reject(new Error('not used')),
    setWorkflowPolicy: () => Promise.reject(new Error('not used')),
    clearWorkflowPolicy: () => Promise.reject(new Error('not used')),
    getWorkflowPolicy,
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
  const listConnectionUsage = vi.fn<
    NonNullable<
      ConnectionDependencies['usagePersistence']
    >['listConnectionUsage']
  >(() => Promise.resolve({ items: [] }));
  const readConnectionSharing = vi.fn(() =>
    Promise.resolve({
      connectionId: destinationId,
      mode: 'restricted' as const,
      revision: 2,
      members: [{ userId: actorId, label: 'Member', active: true }],
    }),
  );
  const replaceConnectionSharing = vi.fn(async () => ({
    ...(await readConnectionSharing()),
    replayed: false,
  }));
  const runtime: ApiConnectionRuntime = Object.freeze({
    dependencies: {
      applicationSecret: 'fixture-application-secret',
      authorization,
      sharingPersistence: { readConnectionSharing, replaceConnectionSharing },
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
        resolveConnectionLookupSecret: () =>
          Promise.reject(new Error('not used')),
      },
      destinationPersistence,
      usagePersistence: { listConnectionUsage },
    },
    close: () => Promise.resolve(),
  });
  return {
    runtime,
    readConnectionSharing,
    replaceConnectionSharing,
    createConnection,
    encryption,
    executeHttp,
    markConnectionTestDispatched,
    appendDestinationVersion,
    getDestination,
    listDestinations,
    getWorkflowPolicy,
    listConnectionUsage,
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

export const connectionUrl = `/v1/workspaces/${workspaceId}/connections`;

export const connectionPayload = {
  providerKey: 'http',
  name: 'Operations API',
  credential: {
    type: 'http_headers',
    headers: { Authorization: credentialValue },
  },
} as const;

export const authenticatedHeaders = {
  cookie: `pertexo_session=${rawSession}; pertexo_csrf=${csrf}`,
  'x-csrf-token': csrf,
  'idempotency-key': 'create-http-stack',
};

export const destinationPath = `/v1/workspaces/${workspaceId}/failure-notification-destinations/${destinationId}/versions`;

export const destinationPayload = {
  expectedVersion: 1,
  config: {
    kind: 'slack',
    connectionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    channelId: 'C67890',
  },
} as const;

export const applicationFixture: {
  application: Awaited<ReturnType<typeof createTestApiApplication>> | undefined;
} = { application: undefined };

export async function start(role: Role = 'owner') {
  const identity = identityRuntime(role);
  const connection = connectionRuntime(identity.dependencies.authorization);
  applicationFixture.application = await createTestApiApplication(config, {
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
  await applicationFixture.application.init();
  return { application: applicationFixture.application, connection };
}

export async function cleanConnectionsRealNestHTTPStackFixture() {
  await applicationFixture.application?.close();
  applicationFixture.application = undefined;
}
