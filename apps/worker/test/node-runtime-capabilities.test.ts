import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { PutArtifactRequest } from '@pertexo/artifact-store';
import { createDatabaseRuntime } from '@pertexo/database/execution';
import type { ConnectionDatabase } from '@pertexo/database/testing';
import { ProviderExecutionRateLimitError } from '@pertexo/node-sdk/server';
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
    const runtime = await createWorkerNodeRuntimeCapabilities({
      connectionEncryption: {
        keyReference: 'alias/pertexo',
        region: 'eu-central-1',
      },
      database: databaseConfig,
      redisUrl: 'redis://localhost:6379/0',
    });

    await expect(runtime.close()).rejects.toThrow(
      'Worker node runtime capability shutdown failed',
    );
    close.mockRestore();
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
      ).rejects.toThrow('Connection is not compatible');
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
    ).rejects.toThrow('Connection auth type is not supported');
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

    await expect(
      artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new Uint8Array([1, 2, 3]);
        })(),
        maxBytes: 2,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(RangeError);
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

  it('rejects incompatible artifact-store metadata and keeps readiness optional', async () => {
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig },
      {
        artifactPersistence: {
          createPending: vi.fn(() => Promise.resolve()),
          finalize: vi.fn(),
        },
        artifactStore: {
          put: (request) =>
            Promise.resolve({
              artifactId: 'wrong',
              workspaceId: request.workspaceId,
              byteLength: request.byteLength,
              mediaType: request.mediaType,
              sha256: request.sha256,
            }),
        },
        artifactId: () => artifactId,
      },
    );
    await expect(runtime.checkReadiness()).resolves.toBeUndefined();
    const artifacts = runtime.factories.artifacts?.(context);
    if (artifacts === undefined) throw new Error('artifact capability missing');
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
  });
});
