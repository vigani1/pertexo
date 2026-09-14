import type { ConnectionRecord } from '@pertexo/database/testing';
import { vi } from 'vitest';

import type {
  ConnectionCommandPersistence,
  ConnectionTestPersistence,
} from '../../../src/connections/ports.js';
import { createActorContext } from '../../../src/workspaces/index.js';
import type { WorkspaceAuthorizationPort } from '../../../src/workspaces/index.js';

type AuthorizationFixture = Readonly<{
  findAccess: ReturnType<
    typeof vi.fn<WorkspaceAuthorizationPort['findAccess']>
  >;
}>;

export const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const secretVersionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const nextSecretVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const credential = {
  schemaVersion: 1,
  type: 'http_headers',
  headers: { Authorization: 'Bearer deeply-secret-value' },
} as const;
export const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  requestId: 'request-42',
});

export function record(
  overrides: Partial<ConnectionRecord> = {},
): ConnectionRecord {
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

export function authorization(): AuthorizationFixture {
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

export function commandPersistence(
  overrides: Partial<ConnectionCommandPersistence> = {},
) {
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

export const sealed = Object.freeze({
  schemaVersion: 1 as const,
  kmsKeyReference: 'alias/pertexo-connections',
  encryptedDataKey: 'encrypted-key',
  ciphertext: 'ciphertext',
  nonce: 'nonce',
  tag: 'tag',
});

export function connectionTestPersistence(
  overrides: Partial<ConnectionTestPersistence> = {},
) {
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
