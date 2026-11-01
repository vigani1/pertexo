import type { ConnectionRecord } from '@pertexo/core/testing';

import { vi } from 'vitest';

import type { ConnectionTestPersistence } from '../../../../src/connections/ports.js';
import { createActorContext } from '../../../../src/authorization/index.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const secretVersionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  requestId: 'connection-test-regression',
});

export const sealed = Object.freeze({
  kmsKeyReference: 'alias/pertexo-connections',
  encryptedDataKey: 'encrypted-key',
  ciphertext: 'ciphertext',
  nonce: 'nonce',
  tag: 'tag',
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
    accessMode: 'workspace',
    lastTestedAt: null,
    lastHealthyAt: null,
    lastErrorCode: null,
    createdBy: actorId,
    createdAt: new Date('2026-08-22T12:00:00.000Z'),
    updatedAt: new Date('2026-08-22T12:00:00.000Z'),
    ...overrides,
  };
}

export function activeAccess() {
  return {
    actorId,
    workspaceId,
    role: 'owner' as const,
    membershipStatus: 'active' as const,
    workspaceStatus: 'active' as const,
  };
}

export function persistence(
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

export function command(request: unknown) {
  return {
    actor,
    routeWorkspaceId: workspaceId,
    connectionId,
    idempotencyKey: 'connection-test-regression',
    request,
  };
}
