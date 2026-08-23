import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { PutArtifactRequest } from '@pertexo/artifact-store';
import type { ConnectionDatabase } from '@pertexo/database';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkerNodeRuntimeCapabilities } from '../src/execution/node-runtime-capabilities.js';

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
    expect(open).toHaveBeenCalledWith(expect.anything(), {
      workspaceId,
      connectionId,
      secretVersionId,
    });
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
    const now = new Date('2026-08-22T12:00:00.000Z');
    const runtime = await createWorkerNodeRuntimeCapabilities(
      { database: databaseConfig, artifactRetentionMillis: 60_000 },
      {
        artifactPersistence: { createPending, finalize },
        artifactStore: { put },
        artifactId: () => artifactId,
        now: () => now,
        spoolDirectory,
      },
    );
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
});
