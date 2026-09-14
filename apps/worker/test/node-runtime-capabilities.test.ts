import { createHash } from 'node:crypto';
import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { PutArtifactRequest } from '@pertexo/artifact-store';
import {
  ConnectionUnavailableError,
  createDatabaseRuntime,
} from '@pertexo/database/execution';
import type { ConnectionDatabase } from '@pertexo/database/testing';
import {
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
} from '@pertexo/node-sdk/server';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkerNodeRuntimeCapabilities } from '../src/testing.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const secretVersionId = '33333333-3333-4333-8333-333333333333';
const artifactId = '44444444-4444-4444-8444-444444444444';
const previewRunId = '99999999-9999-4999-8999-999999999999';
const context = {
  workspaceId,
  runId: '55555555-5555-4555-8555-555555555555',
  nodeRunId: '66666666-6666-4666-8666-666666666666',
  attemptId: '77777777-7777-4777-8777-777777777777',
  attemptNumber: 1,
  nodeId: 'http-node',
  invocationKey: 'http-invocation',
  workerId: 'worker-1',
} as const;

const databaseConfig = {
  connectionString: 'postgresql://worker:password@localhost/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 1_000,
  max: 1,
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('worker node runtime capabilities', () => {
  it.each([59_999, 60_000.5, 365 * 24 * 60 * 60_000 + 1])(
    'rejects invalid artifact retention %s',
    async (artifactRetentionMillis) => {
      await expect(
        createWorkerNodeRuntimeCapabilities({
          database: databaseConfig,
          artifactRetentionMillis,
        }),
      ).rejects.toBeInstanceOf(TypeError);
    },
  );

  it('fails closed for partially configured runtime capabilities', async () => {
    await expect(
      createWorkerNodeRuntimeCapabilities(
        { database: databaseConfig },
        {
          connectionDatabase: {
            resolveConnectionSecret: vi.fn(),
            assertConnectionSecretCurrent: vi.fn(),
          },
        },
      ),
    ).rejects.toThrow('Worker provider rate limiter is incomplete');
    await expect(
      createWorkerNodeRuntimeCapabilities(
        { database: databaseConfig },
        {
          connectionDatabase: {
            resolveConnectionSecret: vi.fn(),
            assertConnectionSecretCurrent: vi.fn(),
          },
          providerRateLimiter: {
            consume: vi.fn().mockResolvedValue({ allowed: true }),
          },
        },
      ),
    ).rejects.toThrow('Worker connection capability is incomplete');
    await expect(
      createWorkerNodeRuntimeCapabilities(
        { database: databaseConfig },
        {
          artifactPersistence: {
            createPending: vi.fn(),
            finalize: vi.fn(),
          },
        },
      ),
    ).rejects.toThrow('Worker artifact capability is incomplete');
  });

  it('preserves construction and synchronous owned-resource cleanup failures', async () => {
    const cleanupError = new Error('injected synchronous Redis close failure');
    const close = vi
      .spyOn(RedisRateLimitRuntime.prototype, 'close')
      .mockImplementationOnce(() => {
        throw cleanupError;
      });
    try {
      const result = await createWorkerNodeRuntimeCapabilities(
        { database: databaseConfig, redisUrl: 'redis://localhost:6379/0' },
        {
          connectionDatabase: {
            resolveConnectionSecret: vi.fn(),
            assertConnectionSecretCurrent: vi.fn(),
          },
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toEqual([
        expect.objectContaining({
          message: 'Worker connection capability is incomplete',
        }),
        cleanupError,
      ]);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
    }
  });

  it('closes partial capability assembly after a database authority failure', async () => {
    const databaseRuntime = createDatabaseRuntime(
      { ...databaseConfig, max: 2 },
      { monitorLockWaits: false, role: 'worker' },
    );
    try {
      await expect(
        createWorkerNodeRuntimeCapabilities(
          { database: databaseConfig },
          {
            connectionEncryption: { open: vi.fn() },
            databaseRuntime,
            providerRateLimiter: {
              consume: vi.fn().mockResolvedValue({ allowed: true }),
            },
          },
        ),
      ).rejects.toThrow(
        'Database runtime authority does not match repository config',
      );
    } finally {
      await databaseRuntime.close();
    }
  });

  it('owns the default artifact persistence database lifecycle', async () => {
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      { artifactStore: { put: vi.fn() } },
    );

    expect(runtime.factories.artifacts).toBeTypeOf('function');
    await runtime.close();
    await runtime.close();
  });

  it('borrows one process database runtime for default capabilities', async () => {
    const databaseRuntime = createDatabaseRuntime(databaseConfig, {
      monitorLockWaits: false,
      role: 'worker',
    });
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        artifactStore: { put: vi.fn() },
        connectionEncryption: { open: vi.fn() },
        databaseRuntime,
        providerRateLimiter: {
          consume: vi.fn().mockResolvedValue({ allowed: true }),
        },
      },
    );

    await runtime.close();
    await databaseRuntime.close();
  });

  it('reports failures while closing owned capability resources', async () => {
    const close = vi
      .spyOn(RedisRateLimitRuntime.prototype, 'close')
      .mockRejectedValueOnce(new Error('injected Redis close failure'));
    try {
      const runtime = await createWorkerNodeRuntimeCapabilities({
        connectionEncryption: {
          keyReference: 'alias/pertexo',
          region: 'eu-central-1',
        },
        database: databaseConfig,
        redisUrl: 'redis://localhost:6379/0',
      });

      const first = runtime.close();
      expect(runtime.close()).toBe(first);
      await expect(first).rejects.toThrow(
        'Worker node runtime capability shutdown failed',
      );
      await expect(runtime.checkReadiness()).rejects.toThrow(
        'Worker node runtime capabilities are closed',
      );
    } finally {
      close.mockRestore();
    }
  });

  it('binds JIT connection resolution and pre-dispatch currency checks to the attempt workspace', async () => {
    const resolveConnectionSecret = vi.fn(() =>
      Promise.resolve({
        connection: {
          id: connectionId,
          workspaceId,
          providerKey: 'http',
          name: 'Provider',
          authType: 'http_headers' as const,
          status: 'active' as const,
          currentSecretVersionId: secretVersionId,
          lastTestedAt: null,
          lastHealthyAt: null,
          lastErrorCode: null,
          createdBy: '88888888-8888-4888-8888-888888888888',
          createdAt: new Date('2026-08-22T00:00:00.000Z'),
          updatedAt: new Date('2026-08-22T00:00:00.000Z'),
        },
        secretVersionId,
        sealed: {
          schemaVersion: 1 as const,
          kmsKeyReference: 'alias/pertexo',
          encryptedDataKey: 'YQ',
          ciphertext: 'Yg',
          nonce: 'YWFhYWFhYWFhYWFh',
          tag: 'YWFhYWFhYWFhYWFhYWFhYQ',
        },
      }),
    );
    const assertConnectionSecretCurrent = vi.fn(() => Promise.resolve());
    const open = vi.fn(() =>
      Promise.resolve(new TextEncoder().encode('secret')),
    );
    const consumeProviderLimit = vi
      .fn()
      .mockResolvedValue({ allowed: true as const });
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        connectionDatabase: {
          resolveConnectionSecret,
          assertConnectionSecretCurrent,
        } satisfies Pick<
          ConnectionDatabase,
          'assertConnectionSecretCurrent' | 'resolveConnectionSecret'
        >,
        connectionEncryption: { open },
        providerRateLimiter: { consume: consumeProviderLimit },
      },
    );
    const connections = runtime.factories.connections?.(context);
    if (connections === undefined)
      throw new Error('connection capability missing');
    const signal = new AbortController().signal;

    const resolved = await connections.resolve({
      connectionId,
      expectedProviderKey: 'http',
      expectedAuthType: 'http_headers',
      purpose: 'http.request.execute',
      signal,
    });
    expect(resolveConnectionSecret).toHaveBeenCalledWith({
      workspaceId,
      connectionId,
      expectedProviderKey: 'http',
      workerId: 'worker-1',
      purpose: 'http.request.execute',
      signal,
    });
    expect(consumeProviderLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointClass: 'provider_execution',
        dimensions: [
          { kind: 'workspace', identifier: workspaceId, limit: 300 },
          { kind: 'connection', identifier: connectionId, limit: 60 },
        ],
      }),
    );
    expect(open).toHaveBeenCalledWith(
      expect.anything(),
      {
        workspaceId,
        connectionId,
        secretVersionId,
      },
      signal,
    );
    expect(new TextDecoder().decode(resolved.secret)).toBe('secret');

    if (connections.assertCurrent === undefined)
      throw new Error('connection currency capability missing');
    await connections.assertCurrent({
      connectionId,
      expectedProviderKey: 'http',
      expectedAuthType: 'http_headers',
      secretVersionId,
      signal,
    });
    expect(assertConnectionSecretCurrent).toHaveBeenCalledWith({
      workspaceId,
      connectionId,
      expectedProviderKey: 'http',
      expectedAuthType: 'http_headers',
      secretVersionId,
      signal,
    });
    await runtime.close();
  });

  it('rejects provider execution before secret or provider work when admission is exhausted', async () => {
    const resolveConnectionSecret = vi.fn();
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        connectionDatabase: {
          resolveConnectionSecret,
          assertConnectionSecretCurrent: vi.fn(),
        },
        connectionEncryption: { open: vi.fn() },
        providerRateLimiter: {
          consume: () =>
            Promise.resolve({
              allowed: false as const,
              retryAfterSeconds: 9,
              limitedDimension: 'connection' as const,
            }),
        },
      },
    );
    const connections = runtime.factories.connections?.(context);
    if (connections === undefined)
      throw new Error('connection capability missing');

    await expect(
      connections.resolve({
        connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: 'http_headers',
        purpose: 'http.request.execute',
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(new ProviderExecutionRateLimitError(9));
    expect(resolveConnectionSecret).not.toHaveBeenCalled();
    await runtime.close();
  });

  it.each([true, false])(
    'gives cancellation precedence when rate admission settles late with allowed=%s',
    async (allowed) => {
      const admission = Promise.withResolvers<
        | { allowed: true }
        | {
            allowed: false;
            retryAfterSeconds: number;
            limitedDimension: 'connection';
          }
      >();
      const resolveConnectionSecret = vi.fn();
      const runtime = await createWorkerNodeRuntimeCapabilities(
        { database: databaseConfig },
        {
          connectionDatabase: {
            resolveConnectionSecret,
            assertConnectionSecretCurrent: vi.fn(),
          },
          connectionEncryption: { open: vi.fn() },
          providerRateLimiter: { consume: () => admission.promise },
        },
      );
      const connections = runtime.factories.connections?.(context);
      if (connections === undefined)
        throw new Error('connection capability missing');
      const controller = new AbortController();
      const resolving = connections.resolve({
        connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: 'http_headers',
        purpose: 'http.request.execute',
        signal: controller.signal,
      });
      controller.abort();
      admission.resolve(
        allowed
          ? { allowed: true }
          : {
              allowed: false,
              retryAfterSeconds: 3,
              limitedDimension: 'connection',
            },
      );

      await expect(resolving).rejects.toMatchObject({ name: 'AbortError' });
      expect(resolveConnectionSecret).not.toHaveBeenCalled();
      await runtime.close();
    },
  );

  it('propagates cancellation into resolution and rechecks it before decryption', async () => {
    const resolvedSecret = Promise.withResolvers<{
      connection: {
        id: string;
        workspaceId: string;
        providerKey: string;
        authType: 'http_headers';
      };
      secretVersionId: string;
      sealed: never;
    }>();
    const resolveConnectionSecret = vi
      .fn()
      .mockReturnValue(resolvedSecret.promise);
    const open = vi.fn();
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        connectionDatabase: {
          resolveConnectionSecret: resolveConnectionSecret as never,
          assertConnectionSecretCurrent: vi.fn(),
        },
        connectionEncryption: { open },
        providerRateLimiter: {
          consume: () => Promise.resolve({ allowed: true as const }),
        },
      },
    );
    const connections = runtime.factories.connections?.(context);
    if (connections === undefined)
      throw new Error('connection capability missing');
    const controller = new AbortController();
    const resolving = connections.resolve({
      connectionId,
      expectedProviderKey: 'http',
      expectedAuthType: 'http_headers',
      purpose: 'http.request.execute',
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(resolveConnectionSecret).toHaveBeenCalledOnce();
    });
    expect(resolveConnectionSecret).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
    controller.abort();
    resolvedSecret.resolve({
      connection: {
        id: connectionId,
        workspaceId,
        providerKey: 'http',
        authType: 'http_headers',
      },
      secretVersionId,
      sealed: {} as never,
    });

    await expect(resolving).rejects.toMatchObject({ name: 'AbortError' });
    expect(open).not.toHaveBeenCalled();
    await runtime.close();
  });

  it('passes Slack bot-token identity through the shared JIT connection fence', async () => {
    const resolveConnectionSecret = vi.fn(() =>
      Promise.resolve({
        connection: {
          id: connectionId,
          workspaceId,
          providerKey: 'slack',
          name: 'Slack',
          authType: 'slack_bot_token' as const,
          status: 'active' as const,
          currentSecretVersionId: secretVersionId,
          lastTestedAt: null,
          lastHealthyAt: null,
          lastErrorCode: null,
          createdBy: '88888888-8888-4888-8888-888888888888',
          createdAt: new Date('2026-08-24T00:00:00.000Z'),
          updatedAt: new Date('2026-08-24T00:00:00.000Z'),
        },
        secretVersionId,
        sealed: {
          schemaVersion: 1 as const,
          kmsKeyReference: 'alias/pertexo',
          encryptedDataKey: 'YQ',
          ciphertext: 'Yg',
          nonce: 'YWFhYWFhYWFhYWFh',
          tag: 'YWFhYWFhYWFhYWFhYWFhYQ',
        },
      }),
    );
    const assertConnectionSecretCurrent = vi.fn(() => Promise.resolve());
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        connectionDatabase: {
          resolveConnectionSecret,
          assertConnectionSecretCurrent,
        } satisfies Pick<
          ConnectionDatabase,
          'assertConnectionSecretCurrent' | 'resolveConnectionSecret'
        >,
        connectionEncryption: {
          open: () => Promise.resolve(new TextEncoder().encode('slack-secret')),
        },
        providerRateLimiter: {
          consume: () => Promise.resolve({ allowed: true as const }),
        },
      },
    );
    const connections = runtime.factories.connections?.(context);
    if (connections?.assertCurrent === undefined)
      throw new Error('connection capability missing');
    const signal = new AbortController().signal;

    await connections.resolve({
      connectionId,
      expectedProviderKey: 'slack',
      expectedAuthType: 'slack_bot_token',
      purpose: 'slack.send_message.execute',
      signal,
    });
    await connections.assertCurrent({
      connectionId,
      expectedProviderKey: 'slack',
      expectedAuthType: 'slack_bot_token',
      secretVersionId,
      signal,
    });

    expect(resolveConnectionSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedProviderKey: 'slack',
        purpose: 'slack.send_message.execute',
      }),
    );
    expect(assertConnectionSecretCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedProviderKey: 'slack',
        expectedAuthType: 'slack_bot_token',
      }),
    );
    await runtime.close();
  });

  it('checks cancellation before lookup and zeroes a secret canceled after decryption', async () => {
    const secret = new TextEncoder().encode('secret');
    const controller = new AbortController();
    const abortAfterOpen: { current?: AbortController } = {};
    const resolveConnectionSecret = vi.fn(() =>
      Promise.resolve({
        connection: {
          id: connectionId,
          workspaceId,
          providerKey: 'http',
          authType: 'http_headers' as const,
        },
        secretVersionId,
        sealed: {} as never,
      }),
    );
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        connectionDatabase: {
          resolveConnectionSecret: resolveConnectionSecret as never,
          assertConnectionSecretCurrent: vi.fn(),
        },
        connectionEncryption: {
          open: () => {
            abortAfterOpen.current?.abort();
            return Promise.resolve(secret);
          },
        },
        providerRateLimiter: {
          consume: () => Promise.resolve({ allowed: true as const }),
        },
      },
    );
    const connections = runtime.factories.connections?.(context);
    if (connections === undefined)
      throw new Error('connection capability missing');
    const request = {
      connectionId,
      expectedProviderKey: 'http',
      expectedAuthType: 'http_headers' as const,
      purpose: 'http.request.execute',
      signal: controller.signal,
    };
    controller.abort();
    await expect(connections.resolve(request)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(resolveConnectionSecret).not.toHaveBeenCalled();

    const secondController = new AbortController();
    abortAfterOpen.current = secondController;
    await expect(
      connections.resolve({ ...request, signal: secondController.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(secret.every((byte) => byte === 0)).toBe(true);
    await runtime.close();
  });

  it('awaits late decryption, clears its secret, and refuses it after cancellation', async () => {
    const decrypted = Promise.withResolvers<Uint8Array>();
    const open = vi.fn().mockReturnValue(decrypted.promise);
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        connectionDatabase: {
          resolveConnectionSecret: vi.fn().mockResolvedValue({
            connection: {
              id: connectionId,
              workspaceId,
              providerKey: 'http',
              authType: 'http_headers',
            },
            secretVersionId,
            sealed: {},
          }),
          assertConnectionSecretCurrent: vi.fn(),
        },
        connectionEncryption: { open },
        providerRateLimiter: {
          consume: () => Promise.resolve({ allowed: true as const }),
        },
      },
    );
    const connections = runtime.factories.connections?.(context);
    if (connections === undefined)
      throw new Error('connection capability missing');
    const controller = new AbortController();
    const resolving = connections.resolve({
      connectionId,
      expectedProviderKey: 'http',
      expectedAuthType: 'http_headers',
      purpose: 'http.request.execute',
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(open).toHaveBeenCalledOnce();
    });
    controller.abort();
    const secret = new TextEncoder().encode('late-secret');
    decrypted.resolve(secret);

    await expect(resolving).rejects.toMatchObject({ name: 'AbortError' });
    expect(secret.every((byte) => byte === 0)).toBe(true);
    await runtime.close();
  });

  it('preserves a hostile unknown database rejection without inspecting it unsafely', async () => {
    const hostile = new Proxy(Object.create(null) as object, {
      getPrototypeOf: () => {
        throw new Error('hostile prototype');
      },
    });
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        connectionDatabase: {
          resolveConnectionSecret: vi.fn().mockRejectedValue(hostile),
          assertConnectionSecretCurrent: vi.fn(),
        },
        connectionEncryption: { open: vi.fn() },
        providerRateLimiter: {
          consume: () => Promise.resolve({ allowed: true as const }),
        },
      },
    );
    const connections = runtime.factories.connections?.(context);
    if (connections === undefined)
      throw new Error('connection capability missing');

    await expect(
      connections.resolve({
        connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: 'http_headers',
        purpose: 'http.request.execute',
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(hostile);
    await runtime.close();
  });

  it.each([
    { authType: 'slack_bot_token', id: connectionId, workspaceId },
    { authType: 'http_headers', id: 'wrong', workspaceId },
    { authType: 'http_headers', id: connectionId, workspaceId: 'wrong' },
  ] as const)(
    'rejects mismatched resolved connection identity %#',
    async (connection) => {
      const open = vi.fn();
      const runtime = await createWorkerNodeRuntimeCapabilities(
        { database: databaseConfig },
        {
          connectionDatabase: {
            resolveConnectionSecret: () =>
              Promise.resolve({
                connection: { ...connection, providerKey: 'http' } as never,
                secretVersionId,
                sealed: {} as never,
              }),
            assertConnectionSecretCurrent: vi.fn(),
          },
          connectionEncryption: { open },
          providerRateLimiter: {
            consume: () => Promise.resolve({ allowed: true as const }),
          },
        },
      );
      const connections = runtime.factories.connections?.(context);
      if (connections === undefined)
        throw new Error('connection capability missing');
      await expect(
        connections.resolve({
          connectionId,
          expectedProviderKey: 'http',
          expectedAuthType: 'http_headers',
          purpose: 'http.request.execute',
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(ProviderCredentialInvalidError);
      expect(open).not.toHaveBeenCalled();
      await runtime.close();
    },
  );

  it('rejects unsupported connection currency auth and post-check cancellation', async () => {
    const controller = new AbortController();
    const assertConnectionSecretCurrent = vi.fn(() => {
      controller.abort();
      return Promise.resolve();
    });
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        connectionDatabase: {
          resolveConnectionSecret: vi.fn(),
          assertConnectionSecretCurrent,
        },
        connectionEncryption: { open: vi.fn() },
        providerRateLimiter: {
          consume: () => Promise.resolve({ allowed: true as const }),
        },
      },
    );
    const assertCurrent =
      runtime.factories.connections?.(context).assertCurrent;
    if (assertCurrent === undefined)
      throw new Error('connection capability missing');
    await expect(
      assertCurrent({
        connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: 'unsupported',
        secretVersionId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ProviderCredentialInvalidError);
    await expect(
      assertCurrent({
        connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: 'http_headers',
        secretVersionId,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await runtime.close();
  });

  it.each([
    ['resolution', 'resolve', new Error('postgres unavailable'), false],
    [
      'revoked resolution',
      'resolve',
      new ConnectionUnavailableError('revoked'),
      true,
    ],
    ['currency check', 'assert', new Error('postgres unavailable'), false],
    [
      'rotated currency check',
      'assert',
      new ConnectionUnavailableError('rotated'),
      true,
    ],
  ] as const)(
    'preserves %s failure semantics at the worker capability boundary',
    async (_name, stage, sourceError, invalidCredential) => {
      const runtime = await createWorkerNodeRuntimeCapabilities(
        { database: databaseConfig },
        {
          connectionDatabase: {
            resolveConnectionSecret: () =>
              stage === 'resolve'
                ? Promise.reject(sourceError)
                : Promise.reject(new Error('not exercised')),
            assertConnectionSecretCurrent: () =>
              stage === 'assert'
                ? Promise.reject(sourceError)
                : Promise.reject(new Error('not exercised')),
          },
          connectionEncryption: { open: vi.fn() },
          providerRateLimiter: {
            consume: () => Promise.resolve({ allowed: true as const }),
          },
        },
      );
      const connections = runtime.factories.connections?.(context);
      if (connections?.assertCurrent === undefined)
        throw new Error('connection capability missing');
      const operation =
        stage === 'resolve'
          ? connections.resolve({
              connectionId,
              expectedProviderKey: 'http',
              expectedAuthType: 'http_headers',
              purpose: 'http.request.execute',
              signal: new AbortController().signal,
            })
          : connections.assertCurrent({
              connectionId,
              expectedProviderKey: 'http',
              expectedAuthType: 'http_headers',
              secretVersionId,
              signal: new AbortController().signal,
            });

      if (invalidCredential)
        await expect(operation).rejects.toBeInstanceOf(
          ProviderCredentialInvalidError,
        );
      else await expect(operation).rejects.toBe(sourceError);
      await runtime.close();
    },
  );

  it('spools a bounded stream, persists pending metadata before upload, finalizes after verification, and cleans up', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const order: string[] = [];
    const createPending = vi.fn(() => {
      order.push('pending');
      return Promise.resolve();
    });
    const finalize = vi.fn(() => {
      order.push('finalized');
      return Promise.resolve();
    });
    const uploaded: number[] = [];
    const put = vi.fn(async (request: PutArtifactRequest) => {
      order.push('upload');
      for await (const chunk of request.body) {
        const value: unknown = chunk;
        if (!(value instanceof Uint8Array))
          throw new TypeError('artifact chunk is not bytes');
        uploaded.push(...value);
      }
      return {
        artifactId: request.artifactId,
        workspaceId: request.workspaceId,
        byteLength: request.byteLength,
        mediaType: request.mediaType,
        sha256: request.sha256,
      };
    });
    const checkReadiness = vi.fn().mockResolvedValue({ bucket: 'artifacts' });
    const now = new Date('2026-08-22T12:00:00.000Z');
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig, artifactRetentionMillis: 60_000 },
      {
        artifactPersistence: { createPending, finalize },
        artifactStore: { checkReadiness, put },
        artifactId: () => artifactId,
        now: () => now,
        spoolDirectory,
      },
    );
    await expect(runtime.checkReadiness()).resolves.toBeUndefined();
    expect(checkReadiness).toHaveBeenCalledOnce();
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');
    const first = new Uint8Array([1, 2]);
    const second = new Uint8Array([3, 4, 5]);

    const reference = await artifacts.write({
      body: (async function* (): AsyncGenerator<Uint8Array> {
        await Promise.resolve();
        yield first;
        yield second;
      })(),
      maxBytes: 5,
      mediaType: 'application/octet-stream',
      purpose: 'node-output',
      signal: new AbortController().signal,
    });

    const sha256 = createHash('sha256')
      .update(Uint8Array.from([1, 2, 3, 4, 5]))
      .digest('hex');
    expect(reference).toEqual({
      artifactId,
      byteLength: 5,
      mediaType: 'application/octet-stream',
      sha256,
    });
    expect(order).toEqual(['pending', 'upload', 'finalized']);
    expect(uploaded).toEqual([1, 2, 3, 4, 5]);
    expect(first.every((byte) => byte === 0)).toBe(true);
    expect(second.every((byte) => byte === 0)).toBe(true);
    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId,
        workspaceId,
        byteLength: 5,
        expiresAt: new Date(now.getTime() + 60_000),
        sha256,
      }),
    );
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it.each([
    ['empty', [] as number[]],
    ['short writes', [1, 2, 3]],
  ] as const)(
    'supports %s while preserving the exact byte count',
    async (mode, bytes) => {
      const spoolDirectory = await mkdtemp(
        path.join(tmpdir(), 'pertexo-capability-test-'),
      );
      temporaryDirectories.push(spoolDirectory);
      const uploaded: number[] = [];
      const runtime = await createWorkerNodeRuntimeCapabilities(
        { database: databaseConfig },
        {
          artifactPersistence: {
            createPending: vi.fn().mockResolvedValue(undefined),
            finalize: vi.fn().mockResolvedValue(undefined),
          },
          artifactStore: {
            put: async (request) => {
              for await (const chunk of request.body) {
                const value: unknown = chunk;
                if (!(value instanceof Uint8Array))
                  throw new TypeError('artifact chunk is not bytes');
                uploaded.push(...value);
              }
              return {
                artifactId: request.artifactId,
                workspaceId: request.workspaceId,
                byteLength: request.byteLength,
                mediaType: request.mediaType,
                sha256: request.sha256,
              };
            },
          },
          ...(mode === 'short writes'
            ? {
                artifactSpoolOperations: {
                  openFile: async (filePath: string) => {
                    const file = await open(filePath, 'wx', 0o600);
                    const write = file.write.bind(file);
                    file.write = ((
                      buffer: Uint8Array,
                      offset: number,
                      _length: number,
                      position: number | null,
                    ) => write(buffer, offset, 1, position)) as never;
                    return file;
                  },
                  removeDirectory: (directory: string) =>
                    rm(directory, { recursive: true, force: true }),
                },
              }
            : {}),
          spoolDirectory,
        },
      );
      const artifacts = runtime.factories.artifacts?.(context);
      if (artifacts === undefined)
        throw new Error('artifact capability missing');
      const source = Uint8Array.from(bytes);

      const reference = await artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          if (source.byteLength > 0) yield source;
        })(),
        maxBytes: Math.max(1, source.byteLength),
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      });
      expect(reference.byteLength).toBe(source.byteLength);
      expect(uploaded).toEqual(bytes);
      expect(source.every((byte) => byte === 0)).toBe(true);
      expect(await readdir(spoolDirectory)).toEqual([]);
      await runtime.close();
    },
  );

  it('does not upload or leave spool data when the bounded stream overflows', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const put = vi.fn();
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending: vi.fn(),
          finalize: vi.fn(),
        },
        artifactStore: { put },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');
    const overflow = new Uint8Array([1, 2, 3]);

    await expect(
      artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield overflow;
        })(),
        maxBytes: 2,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(overflow).toEqual(new Uint8Array([0, 0, 0]));
    expect(put).not.toHaveBeenCalled();
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it('requests source return on abort, awaits the pending chunk, and clears it', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const pendingChunk = Promise.withResolvers<IteratorResult<Uint8Array>>();
    const next = vi.fn().mockReturnValue(pendingChunk.promise);
    const returnIterator = vi.fn().mockResolvedValue({
      done: true as const,
      value: undefined,
    });
    const put = vi.fn();
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending: vi.fn(),
          finalize: vi.fn(),
        },
        artifactStore: { put },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');
    const controller = new AbortController();
    const chunk = new Uint8Array([7, 8]);
    const written = artifacts.write({
      body: {
        [Symbol.asyncIterator]: () => ({ next, return: returnIterator }),
      },
      maxBytes: 2,
      mediaType: 'application/octet-stream',
      purpose: 'node-output',
      signal: controller.signal,
    });
    const settled = vi.fn();
    void written.then(settled, settled);
    await vi.waitFor(() => {
      expect(next).toHaveBeenCalledOnce();
    });

    controller.abort();
    await vi.waitFor(() => {
      expect(returnIterator).toHaveBeenCalledOnce();
    });
    expect(settled).not.toHaveBeenCalled();
    pendingChunk.resolve({ done: false, value: chunk });
    await expect(written).rejects.toMatchObject({ name: 'AbortError' });
    expect(chunk).toEqual(new Uint8Array([0, 0]));
    expect(put).not.toHaveBeenCalled();
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it('preserves source and return failures after clearing an overflowing chunk', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const returnError = new Error('artifact source return failed');
    const overflow = new Uint8Array([1, 2]);
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending: vi.fn(),
          finalize: vi.fn(),
        },
        artifactStore: { put: vi.fn() },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');

    const result = await artifacts
      .write({
        body: {
          [Symbol.asyncIterator]: () => ({
            next: vi
              .fn()
              .mockResolvedValueOnce({ done: false, value: overflow }),
            return: vi.fn().mockRejectedValue(returnError),
          }),
        },
        maxBytes: 1,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors[0]).toBeInstanceOf(RangeError);
    expect((result as AggregateError).errors[1]).toBe(returnError);
    expect(overflow).toEqual(new Uint8Array([0, 0]));
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it('closes an upload stream when the artifact store throws before reading', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const uploadError = new Error('artifact upload rejected before read');
    let uploadBody:
      | (PutArtifactRequest['body'] & {
          closed: boolean;
          destroyed: boolean;
        })
      | undefined;
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending: vi.fn().mockResolvedValue(undefined),
          finalize: vi.fn(),
        },
        artifactStore: {
          put: (request) => {
            uploadBody = request.body;
            throw uploadError;
          },
        },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');

    await expect(
      artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new Uint8Array([1]);
        })(),
        maxBytes: 1,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(uploadError);
    expect(uploadBody).toMatchObject({ closed: true, destroyed: true });
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it('closes a late upload stream and skips finalize when cancellation wins', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const uploadResult = Promise.withResolvers<{
      artifactId: string;
      workspaceId: string;
      byteLength: number;
      mediaType: string;
      sha256: string;
    }>();
    let uploadBody:
      | (PutArtifactRequest['body'] & {
          closed: boolean;
          destroyed: boolean;
        })
      | undefined;
    const put = vi.fn((request: PutArtifactRequest) => {
      uploadBody = request.body;
      return uploadResult.promise;
    });
    const finalize = vi.fn();
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending: vi.fn().mockResolvedValue(undefined),
          finalize,
        },
        artifactStore: { put },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');
    const controller = new AbortController();
    const writing = artifacts.write({
      body: (async function* (): AsyncGenerator<Uint8Array> {
        await Promise.resolve();
        yield new Uint8Array([1]);
      })(),
      maxBytes: 1,
      mediaType: 'application/octet-stream',
      purpose: 'node-output',
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(put).toHaveBeenCalledOnce();
    });
    const request = put.mock.calls[0]?.[0];
    if (request === undefined) throw new Error('upload request missing');

    controller.abort();
    uploadResult.resolve({
      artifactId: request.artifactId,
      workspaceId: request.workspaceId,
      byteLength: request.byteLength,
      mediaType: request.mediaType,
      sha256: request.sha256,
    });
    await expect(writing).rejects.toMatchObject({ name: 'AbortError' });
    expect(uploadBody).toMatchObject({ closed: true, destroyed: true });
    expect(finalize).not.toHaveBeenCalled();
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it('awaits an in-flight spool write after cancellation and then clears its chunk', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const writeResult = Promise.withResolvers<{ bytesWritten: number }>();
    const write = vi.fn().mockReturnValue(writeResult.promise);
    const put = vi.fn();
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending: vi.fn(),
          finalize: vi.fn(),
        },
        artifactStore: { put },
        artifactSpoolOperations: {
          openFile: async (filePath) => {
            const file = await open(filePath, 'wx', 0o600);
            file.write = write as never;
            return file;
          },
          removeDirectory: (directory) =>
            rm(directory, { recursive: true, force: true }),
        },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');
    const controller = new AbortController();
    const chunk = new Uint8Array([9]);
    const writing = artifacts.write({
      body: (async function* (): AsyncGenerator<Uint8Array> {
        await Promise.resolve();
        yield chunk;
      })(),
      maxBytes: 1,
      mediaType: 'application/octet-stream',
      purpose: 'node-output',
      signal: controller.signal,
    });
    const settled = vi.fn();
    void writing.then(settled, settled);
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledOnce();
    });

    controller.abort();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(chunk).toEqual(new Uint8Array([9]));
    writeResult.resolve({ bytesWritten: 1 });
    await expect(writing).rejects.toMatchObject({ name: 'AbortError' });
    expect(chunk).toEqual(new Uint8Array([0]));
    expect(put).not.toHaveBeenCalled();
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it('rejects a zero-progress spool write without uploading or leaking data', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const put = vi.fn();
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending: vi.fn(),
          finalize: vi.fn(),
        },
        artifactStore: { put },
        artifactSpoolOperations: {
          openFile: async (filePath) => {
            const file = await open(filePath, 'wx', 0o600);
            file.write = vi.fn().mockResolvedValue({ bytesWritten: 0 });
            return file;
          },
          removeDirectory: (directory) =>
            rm(directory, { recursive: true, force: true }),
        },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');

    await expect(
      artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new Uint8Array([1]);
        })(),
        maxBytes: 1,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Artifact spool made no write progress');
    expect(put).not.toHaveBeenCalled();
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it('preserves sole and combined spool file-close failures', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const sourceError = new Error('injected artifact source failure');
    const closeError = new Error('injected spool close failure');
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending: vi.fn(),
          finalize: vi.fn(),
        },
        artifactStore: { put: vi.fn() },
        artifactSpoolOperations: {
          openFile: async (filePath) => {
            const file = await open(filePath, 'wx', 0o600);
            const closeFile = file.close.bind(file);
            file.close = vi.fn(async () => {
              await closeFile();
              throw closeError;
            });
            return file;
          },
          removeDirectory: (directory) =>
            rm(directory, { recursive: true, force: true }),
        },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');

    await expect(
      artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new Uint8Array([1]);
        })(),
        maxBytes: 2,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(closeError);
    await expect(
      artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new Uint8Array([1]);
          throw sourceError;
        })(),
        maxBytes: 2,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([
        sourceError,
        closeError,
      ]);
      return true;
    });
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it('normalizes a non-Error spool cleanup rejection', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending: vi.fn(),
          finalize: vi.fn(),
        },
        artifactStore: { put: vi.fn() },
        artifactSpoolOperations: {
          openFile: async (filePath) => {
            const file = await open(filePath, 'wx', 0o600);
            const closeFile = file.close.bind(file);
            file.close = vi.fn(async () => {
              await closeFile();
              // Deliberately model a hostile adapter rejection.
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
              return Promise.reject(undefined);
            });
            return file;
          },
          removeDirectory: (directory) =>
            rm(directory, { recursive: true, force: true }),
        },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');

    await expect(
      artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new Uint8Array([1]);
        })(),
        maxBytes: 1,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      message: 'Artifact cleanup failed with a non-Error value',
      cause: undefined,
    });
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it('preserves sole and combined spool-directory cleanup failures', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const cleanupError = new Error('spool directory removal failed');
    const operationError = new Error('pending metadata failed');
    const createPending = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(operationError);
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending,
          finalize: vi.fn().mockResolvedValue(undefined),
        },
        artifactStore: {
          put: async (request) => {
            for await (const chunk of request.body) {
              // Consume the owned upload stream before acknowledging storage.
              void chunk;
            }
            return {
              artifactId: request.artifactId,
              workspaceId: request.workspaceId,
              byteLength: request.byteLength,
              mediaType: request.mediaType,
              sha256: request.sha256,
            };
          },
        },
        artifactSpoolOperations: {
          openFile: (filePath) => open(filePath, 'wx', 0o600),
          removeDirectory: vi.fn().mockRejectedValue(cleanupError),
        },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');
    const write = () =>
      artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new Uint8Array([1]);
        })(),
        maxBytes: 1,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      });

    await expect(write()).rejects.toBe(cleanupError);
    const combined = await write().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(combined).toBeInstanceOf(AggregateError);
    expect((combined as AggregateError).errors).toEqual([
      operationError,
      cleanupError,
    ]);
    await runtime.close();
  });

  it('rejects an undefined artifact operation failure and still removes its spool directory', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const put = vi.fn();
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          // Deliberately exercise a hostile non-Error adapter rejection.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          createPending: () => Promise.reject(undefined),
          finalize: vi.fn(),
        },
        artifactStore: { put },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');

    let rejection: unknown;
    let rejected = false;
    try {
      await artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new Uint8Array([1]);
        })(),
        maxBytes: 1,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      });
    } catch (error) {
      rejected = true;
      rejection = error;
    }
    expect(rejected).toBe(true);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe(
      'Artifact operation failed with a non-Error value',
    );
    expect(Object.hasOwn(rejection as Error, 'cause')).toBe(true);
    expect((rejection as Error).cause).toBeUndefined();
    expect(put).not.toHaveBeenCalled();
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it('rejects an already-aborted artifact write before creating spool data', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const put = vi.fn();
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending: vi.fn(),
          finalize: vi.fn(),
        },
        artifactStore: { put },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');
    const controller = new AbortController();
    controller.abort();

    await expect(
      artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new Uint8Array([1]);
        })(),
        maxBytes: 1,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(put).not.toHaveBeenCalled();
    expect(await readdir(spoolDirectory)).toEqual([]);
    await runtime.close();
  });

  it('generates UUIDv7 identities for persisted artifacts by default', async () => {
    const spoolDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-capability-test-'),
    );
    temporaryDirectories.push(spoolDirectory);
    const createPending = vi.fn(() => Promise.resolve());
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending,
          finalize: vi.fn(() => Promise.resolve()),
        },
        artifactStore: {
          put: async (request) => {
            for await (const _chunk of request.body) void _chunk;
            return {
              artifactId: request.artifactId,
              workspaceId: request.workspaceId,
              byteLength: request.byteLength,
              mediaType: request.mediaType,
              sha256: request.sha256,
            };
          },
        },
        spoolDirectory,
      },
    );
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');

    const reference = await artifacts.write({
      body: (async function* (): AsyncGenerator<Uint8Array> {
        await Promise.resolve();
        yield new Uint8Array([1]);
      })(),
      maxBytes: 1,
      mediaType: 'application/octet-stream',
      purpose: 'node-output',
      signal: new AbortController().signal,
    });

    expect(reference.artifactId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: reference.artifactId }),
    );
    await runtime.close();
  });

  it('caps artifact retention at the owning preview deadline', async () => {
    const createPending = vi.fn(() => Promise.resolve());
    const now = new Date('2026-08-22T12:00:00.000Z');
    const previewDeadline = new Date(now.getTime() + 10_000);
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig, artifactRetentionMillis: 60_000 },
      {
        artifactPersistence: {
          createPending,
          finalize: vi.fn(() => Promise.resolve()),
        },
        artifactStore: {
          put: async (request) => {
            for await (const _chunk of request.body) void _chunk;
            return {
              artifactId: request.artifactId,
              workspaceId: request.workspaceId,
              byteLength: request.byteLength,
              mediaType: request.mediaType,
              sha256: request.sha256,
            };
          },
        },
        now: () => now,
      },
    );
    const artifacts = runtime.factories.artifacts?.({
      ...context,
      artifactRetentionDeadline: previewDeadline,
      previewRunId,
    });
    if (artifacts === undefined) throw new Error('artifact capability missing');

    await artifacts.write({
      body: (async function* (): AsyncGenerator<Uint8Array> {
        await Promise.resolve();
        yield new Uint8Array([1]);
      })(),
      maxBytes: 1,
      mediaType: 'application/octet-stream',
      purpose: 'node-output',
      signal: new AbortController().signal,
    });

    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: previewDeadline,
        previewRunId,
      }),
    );
    await runtime.close();
  });

  it.each([new Date(Number.NaN), new Date(8.64e15)])(
    'rejects an invalid or overflowing artifact clock %s before persistence',
    async (clock) => {
      const createPending = vi.fn();
      const runtime = await createWorkerNodeRuntimeCapabilities(
        { database: databaseConfig, artifactRetentionMillis: 60_000 },
        {
          artifactPersistence: { createPending, finalize: vi.fn() },
          artifactStore: { put: vi.fn() },
          now: () => clock,
        },
      );
      try {
        const artifacts = runtime.factories.artifacts?.(context);
        if (artifacts === undefined)
          throw new Error('artifact capability missing');
        await expect(
          artifacts.write({
            body: (async function* (): AsyncGenerator<Uint8Array> {
              await Promise.resolve();
              yield new Uint8Array([1]);
            })(),
            maxBytes: 1,
            mediaType: 'application/octet-stream',
            purpose: 'node-output',
            signal: new AbortController().signal,
          }),
        ).rejects.toBeInstanceOf(TypeError);
        expect(createPending).not.toHaveBeenCalled();
      } finally {
        await runtime.close();
      }
    },
  );

  it.each([0, 1.5, 10_485_761])(
    'rejects invalid artifact byte limit %s',
    async (maxBytes) => {
      const runtime = await createWorkerNodeRuntimeCapabilities(
        { database: databaseConfig },
        {
          artifactPersistence: { createPending: vi.fn(), finalize: vi.fn() },
          artifactStore: { put: vi.fn() },
        },
      );
      const artifacts = runtime.factories.artifacts?.(context);
      if (artifacts === undefined)
        throw new Error('artifact capability missing');
      await expect(
        artifacts.write({
          body: (async function* (): AsyncGenerator<Uint8Array> {
            await Promise.resolve();
            yield new Uint8Array();
          })(),
          maxBytes,
          mediaType: 'text/plain',
          purpose: 'test',
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(TypeError);
      await runtime.close();
    },
  );

  it.each([new Date(Number.NaN), new Date('2026-08-22T11:59:59.000Z')])(
    'rejects invalid artifact deadline %s',
    async (artifactRetentionDeadline) => {
      const now = new Date('2026-08-22T12:00:00.000Z');
      const runtime = await createWorkerNodeRuntimeCapabilities(
        { database: databaseConfig },
        {
          artifactPersistence: { createPending: vi.fn(), finalize: vi.fn() },
          artifactStore: { put: vi.fn() },
          now: () => now,
        },
      );
      const artifacts = runtime.factories.artifacts?.({
        ...context,
        artifactRetentionDeadline,
      });
      if (artifacts === undefined)
        throw new Error('artifact capability missing');
      await expect(
        artifacts.write({
          body: (async function* (): AsyncGenerator<Uint8Array> {
            await Promise.resolve();
            yield new Uint8Array();
          })(),
          maxBytes: 1,
          mediaType: 'text/plain',
          purpose: 'test',
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(
        artifactRetentionDeadline.getTime() <= now.getTime()
          ? RangeError
          : TypeError,
      );
      await runtime.close();
    },
  );

  it.each([
    ['artifactId', 'wrong-artifact'],
    ['workspaceId', 'wrong-workspace'],
    ['byteLength', 2],
    ['mediaType', 'wrong/type'],
    ['sha256', '0'.repeat(64)],
  ] as const)(
    'rejects incompatible artifact-store %s metadata and keeps readiness optional',
    async (field, value) => {
      const runtime = await createWorkerNodeRuntimeCapabilities(
        { database: databaseConfig },
        {
          artifactPersistence: {
            createPending: vi.fn(() => Promise.resolve()),
            finalize: vi.fn(),
          },
          artifactStore: {
            put: (request) => {
              const uploaded = {
                artifactId: request.artifactId,
                workspaceId: request.workspaceId,
                byteLength: request.byteLength,
                mediaType: request.mediaType,
                sha256: request.sha256,
              };
              return Promise.resolve({ ...uploaded, [field]: value } as never);
            },
          },
          artifactId: () => artifactId,
        },
      );
      await expect(runtime.checkReadiness()).resolves.toBeUndefined();
      const artifacts = runtime.factories.artifacts?.(context);
      if (artifacts === undefined)
        throw new Error('artifact capability missing');
      await expect(
        artifacts.write({
          body: (async function* (): AsyncGenerator<Uint8Array> {
            await Promise.resolve();
            yield new Uint8Array([1]);
          })(),
          maxBytes: 1,
          mediaType: 'text/plain',
          purpose: 'test',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('Artifact store returned incompatible metadata');
      await runtime.close();
      await runtime.close();
    },
  );
});
