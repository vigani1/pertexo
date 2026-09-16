import { describe, expect, it, vi } from 'vitest';

import { ConnectionsController } from '../../src/connections/controllers.js';
import { mapConnectionError } from '../../src/connections/errors.js';
import { APPLICATION_ERROR_CATALOG } from '../../src/platform/http/index.js';
import type {
  CreateConnectionUseCase,
  GetConnectionUseCase,
  ListConnectionsUseCase,
  RevokeConnectionUseCase,
  RotateConnectionSecretUseCase,
  TestConnectionUseCase,
} from '../../src/connections/use-cases.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const guardActorId = '99999999-9999-4999-8999-999999999999';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const secretVersionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const connectionResponse = Object.freeze({
  id: connectionId,
  workspaceId,
  providerKey: 'http' as const,
  name: 'Operations API',
  authType: 'http_headers' as const,
  status: 'active' as const,
  secretVersionId,
  health: {
    lastTestedAt: null,
    lastHealthyAt: null,
    lastErrorCode: null,
  },
  createdAt: '2026-08-22T12:00:00.000Z',
  updatedAt: '2026-08-22T12:00:00.000Z',
});

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
  const list = {
    execute: vi.fn<ListConnectionsUseCase['execute']>(() =>
      Promise.resolve({ items: [connectionResponse], nextCursor: null }),
    ),
  };
  const read = {
    execute: vi.fn<GetConnectionUseCase['execute']>(() =>
      Promise.resolve(connectionResponse),
    ),
  };
  const create = {
    execute: vi.fn<CreateConnectionUseCase['execute']>(() =>
      Promise.resolve(connectionResponse),
    ),
  };
  const rotate = {
    execute: vi.fn<RotateConnectionSecretUseCase['execute']>(() =>
      Promise.resolve(connectionResponse),
    ),
  };
  const revoke = {
    execute: vi.fn<RevokeConnectionUseCase['execute']>(() =>
      Promise.resolve({ ...connectionResponse, status: 'revoked' }),
    ),
  };
  const test = {
    execute: vi.fn<TestConnectionUseCase['execute']>(() =>
      Promise.resolve({
        connection: connectionResponse,
        outcome: { ok: true, httpStatus: 204, errorCode: null },
      }),
    ),
  };
  return {
    instance: new ConnectionsController(
      list as unknown as ListConnectionsUseCase,
      read as unknown as GetConnectionUseCase,
      create as unknown as CreateConnectionUseCase,
      rotate as unknown as RotateConnectionSecretUseCase,
      revoke as unknown as RevokeConnectionUseCase,
      test as unknown as TestConnectionUseCase,
    ),
    list,
    read,
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
  it('validates and forwards list and read queries through the guarded context', async () => {
    const { instance, list, read } = controller();
    await instance.list(
      request(),
      { workspaceId },
      { limit: '1', after: 'cursor-1' },
    );
    await instance.read(request(), { workspaceId, connectionId });

    const listInput = list.execute.mock.calls[0]?.[0];
    const readInput = read.execute.mock.calls[0]?.[0];
    expect(listInput).toMatchObject({
      routeWorkspaceId: workspaceId,
      limit: 1,
      after: 'cursor-1',
    });
    expect(listInput?.actor).toMatchObject({ actorId, workspaceId });
    expect(readInput).toMatchObject({
      routeWorkspaceId: workspaceId,
      connectionId,
    });
    expect(readInput?.actor).toMatchObject({ actorId, workspaceId });
  });

  it('rejects unknown list query fields before delegating', () => {
    const { instance, list } = controller();
    expect(() =>
      instance.list(request(), { workspaceId }, { provider: 'http' }),
    ).toThrow();
    expect(list.execute).not.toHaveBeenCalled();
  });

  it('forwards create input with immutable actor and request metadata once', async () => {
    const { instance, create } = controller();
    const body = { providerKey: 'http', name: 'Operations API', credential };
    await instance.create(
      request({ 'idempotency-key': 'create-42' }),
      { workspaceId },
      body,
    );
    expect(create.execute).toHaveBeenCalledOnce();
    const command = create.execute.mock.calls[0]?.[0];
    if (command === undefined)
      throw new Error('controller did not forward a command');
    expect(command).toEqual({
      actor: {
        actorId,
        kind: 'user',
        workspaceId,
        sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        requestId: 'request-42',
        traceId: 'trace-42',
      },
      routeWorkspaceId: workspaceId,
      request: body,
      idempotencyKey: 'create-42',
      requestId: 'request-42',
      traceId: 'trace-42',
      signal: command.signal,
    });
    expect(command.signal).toBeInstanceOf(AbortSignal);
    expect(Object.isFrozen(command.actor)).toBe(true);
    expect(command).not.toHaveProperty('authorizedWorkspace');
  });

  it('forwards rotation with the exact guarded actor, identifiers, and operation signal', async () => {
    const { instance, rotate } = controller();
    const base = request({ 'idempotency-key': 'rotate-guarded' });
    const authorizedWorkspace = {
      actor: Object.freeze({
        actorId: guardActorId,
        kind: 'user' as const,
        workspaceId,
        sessionId: base.identitySession.sessionId,
        requestId: 'rotate-request',
        traceId: 'rotate-trace',
      }),
      workspaceId,
      role: 'owner' as const,
      capability: 'connection:manage' as const,
    };
    const body = { expectedSecretVersionId: secretVersionId, credential };

    await instance.rotate(
      { ...base, authorizedWorkspace },
      { workspaceId, connectionId },
      body,
    );

    expect(rotate.execute).toHaveBeenCalledWith({
      actor: authorizedWorkspace.actor,
      authorizedWorkspace,
      routeWorkspaceId: workspaceId,
      connectionId,
      request: body,
      idempotencyKey: 'rotate-guarded',
      requestId: 'rotate-request',
      traceId: 'rotate-trace',
      signal: rotate.execute.mock.calls[0]?.[0].signal,
    });
    expect(rotate.execute.mock.calls[0]?.[0].signal).toBeInstanceOf(
      AbortSignal,
    );
  });

  it('gives guarded actor and identifiers precedence over session context', async () => {
    const { instance, create } = controller();
    const base = request({ 'idempotency-key': 'guard-context' });
    const authorizedWorkspace = {
      actor: Object.freeze({
        actorId: guardActorId,
        kind: 'user' as const,
        workspaceId,
        sessionId: base.identitySession.sessionId,
        requestId: 'guard-request',
        traceId: 'guard-trace',
      }),
      workspaceId,
      role: 'owner' as const,
      capability: 'connection:manage' as const,
    };
    await instance.create(
      { ...base, authorizedWorkspace },
      { workspaceId },
      { providerKey: 'http', name: 'Guarded', credential },
    );
    expect(create.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: authorizedWorkspace.actor,
        authorizedWorkspace,
        requestId: 'guard-request',
        traceId: 'guard-trace',
      }),
    );
  });

  it('maps an invalid session actor from the controller to request.invalid status 400', async () => {
    const { instance, create } = controller();
    const invalid = {
      ...request({ 'idempotency-key': 'invalid-actor' }),
      identitySession: { ...request().identitySession, userId: 'not-a-uuid' },
    };
    let thrown: unknown;
    try {
      await instance.create(
        invalid,
        { workspaceId },
        { providerKey: 'http', name: 'Invalid', credential },
      );
    } catch (error) {
      thrown = error;
    }
    expect(mapConnectionError(thrown)).toMatchObject({
      code: 'request.invalid',
    });
    expect(APPLICATION_ERROR_CATALOG['request.invalid'].status).toBe(400);
    expect(create.execute).not.toHaveBeenCalled();
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

  it('forwards unknown connection input to the independently safe use case', async () => {
    const { instance, create } = controller();
    const body = {
      providerKey: 'http',
      name: 'Operations API',
      credential: {
        schemaVersion: 1,
        type: 'http_headers',
        headers: { Host: 'metadata.internal' },
      },
    };
    await instance.create(
      request({ 'idempotency-key': 'create-42' }),
      { workspaceId },
      body,
    );
    expect(create.execute).toHaveBeenCalledWith(
      expect.objectContaining({ request: body }),
    );
  });

  it('parses and forwards revoke without accepting a credential body', async () => {
    const { instance, revoke } = controller();
    await instance.revoke(request(), { workspaceId, connectionId });
    expect(revoke.execute).toHaveBeenCalledWith(
      expect.objectContaining({ routeWorkspaceId: workspaceId, connectionId }),
    );
  });

  it('requires idempotency and forwards unknown test input to the safe use case', async () => {
    const { instance, test } = controller();
    const body = { url: 'https://provider.example.test/health' };
    await instance.test(
      request({ 'idempotency-key': 'test-42' }),
      { workspaceId, connectionId },
      body,
    );
    const command = test.execute.mock.calls[0]?.[0];
    if (command === undefined)
      throw new Error('controller did not forward a test command');
    expect(command).toEqual({
      actor: {
        actorId,
        kind: 'user',
        workspaceId,
        sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        requestId: 'request-42',
        traceId: 'trace-42',
      },
      routeWorkspaceId: workspaceId,
      connectionId,
      idempotencyKey: 'test-42',
      request: body,
      requestId: 'request-42',
      traceId: 'trace-42',
      signal: command.signal,
    });
    expect(command.signal).toBeInstanceOf(AbortSignal);
    await instance.test(
      request({ 'idempotency-key': 'test-43' }),
      { workspaceId, connectionId },
      { url: 'http://provider.example.test/health' },
    );
    expect(test.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        request: { url: 'http://provider.example.test/health' },
      }),
    );
  });
});
