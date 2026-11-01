import type { ConnectionDatabase } from '@pertexo/core/testing';
import { ProviderExecutionRateLimitError } from '@pertexo/node-sdk/server';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit';
import { expect, it, vi } from 'vitest';

import {
  workspaceId,
  connectionId,
  secretVersionId,
  context,
  databaseConfig,
  createOwnedCapabilities,
} from '../fixture.js';

export function registerCapabilityShutdownFailures(): void {
  it('reports failures while closing owned capability resources', async () => {
    const close = vi
      .spyOn(RedisRateLimitRuntime.prototype, 'close')
      .mockRejectedValueOnce(new Error('injected Redis close failure'));
    try {
      const runtime = await createOwnedCapabilities({
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
          accessMode: 'workspace' as const,
          createdAt: new Date('2026-08-22T00:00:00.000Z'),
          updatedAt: new Date('2026-08-22T00:00:00.000Z'),
        },
        secretVersionId,
        sealed: {
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
    const runtime = await createOwnedCapabilities(
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
    const runtime = await createOwnedCapabilities(
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
}
