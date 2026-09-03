import { describe, expect, it, vi } from 'vitest';

import { ConnectionsController } from '../../src/connections/controllers.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const secretVersionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function request(headers: Record<string, string> = {}) {
  return {
    requestId: 'request-42',
    traceId: 'trace-42',
    headers,
    identitySession: {
      userId: actorId,
      sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      expiresAt: new Date('2026-08-22T20:00:00.000Z'),
      clientMetadata: {},
    },
  } as const;
}

function controller() {
  const create = {
    execute: vi.fn<(command: unknown) => Promise<{ id: string }>>(() =>
      Promise.resolve({ id: connectionId }),
    ),
  };
  const rotate = {
    execute: vi.fn<(command: unknown) => Promise<{ id: string }>>(() =>
      Promise.resolve({ id: connectionId }),
    ),
  };
  const revoke = {
    execute: vi.fn<(command: unknown) => Promise<{ id: string }>>(() =>
      Promise.resolve({ id: connectionId }),
    ),
  };
  const test = {
    execute: vi.fn<
      (command: unknown) => Promise<{ connection: { id: string } }>
    >(() => Promise.resolve({ connection: { id: connectionId } })),
  };
  return {
    instance: new ConnectionsController(
      create as never,
      rotate as never,
      revoke as never,
      test as never,
    ),
    create,
    rotate,
    revoke,
    test,
  };
}

const credential = {
  schemaVersion: 1,
  type: 'http_headers',
  headers: { Authorization: 'Bearer secret' },
} as const;

describe('connections controller public seam', () => {
  it('parses create input and forwards immutable actor and request metadata once', async () => {
    const { instance, create } = controller();
    await instance.create(
      request({ 'idempotency-key': 'create-42' }),
      { workspaceId },
      { providerKey: 'http', name: 'Operations API', credential },
    );
    expect(create.execute).toHaveBeenCalledOnce();
    expect(create.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        routeWorkspaceId: workspaceId,
        idempotencyKey: 'create-42',
        requestId: 'request-42',
        traceId: 'trace-42',
      }),
    );
    const command = create.execute.mock.calls[0]?.[0];
    expect(command).toMatchObject({ actor: { actorId, workspaceId } });
    if (
      typeof command !== 'object' ||
      command === null ||
      !('actor' in command)
    )
      throw new Error('controller did not forward an actor');
    expect(Object.isFrozen(command.actor)).toBe(true);
  });

  it('requires an idempotency key before delegating create or rotation', async () => {
    const { instance, create, rotate } = controller();
    await expect(
      instance.create(
        request(),
        { workspaceId },
        {
          providerKey: 'http',
          name: 'Operations API',
          credential,
        },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      instance.rotate(
        request(),
        { workspaceId, connectionId },
        { expectedSecretVersionId: secretVersionId, credential },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(create.execute).not.toHaveBeenCalled();
    expect(rotate.execute).not.toHaveBeenCalled();
  });

  it('rejects transport-controlled credential headers before delegation', async () => {
    const { instance, create } = controller();
    await expect(
      instance.create(
        request({ 'idempotency-key': 'create-42' }),
        { workspaceId },
        {
          providerKey: 'http',
          name: 'Operations API',
          credential: {
            schemaVersion: 1,
            type: 'http_headers',
            headers: { Host: 'metadata.internal' },
          },
        },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(create.execute).not.toHaveBeenCalled();
  });

  it('parses and forwards revoke without accepting a credential body', async () => {
    const { instance, revoke } = controller();
    await instance.revoke(request(), { workspaceId, connectionId });
    expect(revoke.execute).toHaveBeenCalledWith(
      expect.objectContaining({ routeWorkspaceId: workspaceId, connectionId }),
    );
  });

  it('requires idempotency and forwards a bounded HTTPS connection test', async () => {
    const { instance, test } = controller();
    await instance.test(
      request({ 'idempotency-key': 'test-42' }),
      { workspaceId, connectionId },
      { url: 'https://provider.example.test/health' },
    );
    expect(test.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        routeWorkspaceId: workspaceId,
        connectionId,
        idempotencyKey: 'test-42',
        request: { url: 'https://provider.example.test/health' },
      }),
    );
    await expect(
      instance.test(
        request({ 'idempotency-key': 'test-43' }),
        { workspaceId, connectionId },
        { url: 'http://provider.example.test/health' },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
  });
});
