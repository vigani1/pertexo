import { createHash } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PutArtifactRequest } from '@pertexo/artifact-store';
import { ConnectionUnavailableError } from '@pertexo/database/connections';

import { ProviderCredentialInvalidError } from '@pertexo/node-sdk/server';

import { expect, it, vi } from 'vitest';

import {
  workspaceId,
  connectionId,
  secretVersionId,
  artifactId,
  context,
  databaseConfig,
  temporaryDirectories,
  createOwnedCapabilities,
} from '../fixture.js';

export function registerHttpFailureClassification(): void {
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
      const runtime = await createOwnedCapabilities(
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
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig, artifactRetentionMillis: 60_000 },
      {
        artifactPersistence: { createPending, finalize },
        artifactStore: { checkReadiness, put },
        artifactId: () => artifactId,
        now: () => now,
        spoolDirectory,
      },
    );
    // performance-03: the store is only reported on; it doesn't gate readiness.
    await expect(runtime.checkReadiness()).resolves.toBeUndefined();
    expect(checkReadiness).not.toHaveBeenCalled();
    await expect(runtime.checkObjectStore()).resolves.toBeUndefined();
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
}
