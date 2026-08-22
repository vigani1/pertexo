import type { ConnectionRecord } from '@pertexo/database';
import { describe, expect, it, vi } from 'vitest';

import type { ConnectionPersistence } from '../../src/connections/ports.js';
import {
  CreateConnectionUseCase,
  RevokeConnectionUseCase,
  RotateConnectionSecretUseCase,
} from '../../src/connections/use-cases.js';
import { createActorContext } from '../../src/workspaces/index.js';

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

function persistence(overrides: Partial<ConnectionPersistence> = {}) {
  return {
    createConnection: vi.fn<ConnectionPersistence['createConnection']>(() =>
      Promise.resolve(record()),
    ),
    findConnectionCreateReplay: vi.fn<
      ConnectionPersistence['findConnectionCreateReplay']
    >(() => Promise.resolve(null)),
    findConnectionRotateReplay: vi.fn<
      ConnectionPersistence['findConnectionRotateReplay']
    >(() => Promise.resolve(null)),
    rotateConnectionSecret: vi.fn<
      ConnectionPersistence['rotateConnectionSecret']
    >(() =>
      Promise.resolve(record({ currentSecretVersionId: nextSecretVersionId })),
    ),
    revokeConnection: vi.fn<ConnectionPersistence['revokeConnection']>(() =>
      Promise.resolve(record({ status: 'revoked' })),
    ),
    ...overrides,
  } satisfies ConnectionPersistence;
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
  it('authorizes, seals, persists, zeroes plaintext, and returns no credential material', async () => {
    const createConnection = vi.fn<ConnectionPersistence['createConnection']>(
      () => Promise.resolve(record()),
    );
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
    });

    expect(encryption.seal).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ workspaceId }),
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
      ConnectionPersistence['rotateConnectionSecret']
    >(() =>
      Promise.resolve(record({ currentSecretVersionId: nextSecretVersionId })),
    );
    const revokeConnection = vi.fn<ConnectionPersistence['revokeConnection']>(
      () => Promise.resolve(record({ status: 'revoked' })),
    );
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
});
