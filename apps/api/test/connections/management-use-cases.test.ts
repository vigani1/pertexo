import { describe, expect, it, vi } from 'vitest';

import type { ConnectionCommandPersistence } from '../../src/connections/ports.js';
import {
  CreateConnectionUseCase,
  RevokeConnectionUseCase,
  RotateConnectionSecretUseCase,
} from '../../src/connections/use-cases.js';
import { authorizeWorkspace } from '../../src/workspaces/index.js';
import {
  actor,
  actorId,
  authorization,
  commandPersistence,
  connectionId,
  credential,
  nextSecretVersionId,
  record,
  sealed,
  secretVersionId,
  workspaceId,
} from './support/use-case-fixture.js';

describe('connection management use cases', () => {
  it('rejects an invalid create body before encryption', async () => {
    const store = commandPersistence();
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

    await new RevokeConnectionUseCase(commandPersistence(), access).execute({
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
    const store = commandPersistence({ createConnection });
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
    const store = commandPersistence();
    const encryption = {
      seal: vi.fn((value: Uint8Array) => {
        plaintext = value;
        controller.abort();
        return Promise.resolve(sealed);
      }),
    };

    await expect(
      new CreateConnectionUseCase(store, authorization(), encryption).execute({
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
    const store = commandPersistence({
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
    const store = commandPersistence({
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
    const store = commandPersistence({
      rotateConnectionSecret,
      revokeConnection,
    });
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
    const store = commandPersistence();
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
