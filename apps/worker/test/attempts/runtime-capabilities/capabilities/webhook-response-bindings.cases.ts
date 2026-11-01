import { createDatabaseRuntime } from '@pertexo/database/platform';

import { RedisRateLimitRuntime } from '@pertexo/rate-limit';
import { expect, it, vi } from 'vitest';

import {
  previewRunId,
  context,
  databaseConfig,
  createOwnedCapabilities,
} from '../fixture.js';

export function registerWebhookResponseBindings(): void {
  it('binds webhook responses to the current attempt and keeps previews out of persistence', async () => {
    const respond = vi
      .fn()
      .mockResolvedValue({ outcome: 'responded', statusCode: 200 });
    const runtime = await createOwnedCapabilities(
      { database: databaseConfig },
      { webhookResponses: { respond } },
    );
    const response = {
      statusCode: 200,
      contentType: 'application/json' as const,
      headers: {},
      body: '{"ok":true}',
    };
    const signal = new AbortController().signal;
    try {
      const real = runtime.factories.webhookResponse?.(context);
      if (real === undefined) throw new Error('Webhook capability missing');
      expect(await real.respond({ response, signal })).toEqual({
        outcome: 'responded',
        statusCode: 200,
      });
      expect(respond).toHaveBeenCalledWith({ ...context, response, signal });
      const draftTest = runtime.factories.webhookResponse?.({
        ...context,
        testRun: true,
      });
      if (draftTest === undefined)
        throw new Error('Draft test response capability missing');
      expect(await draftTest.respond({ response, signal })).toEqual({
        outcome: 'preview',
        statusCode: response.statusCode,
      });
      expect(respond).toHaveBeenCalledTimes(1);
      const preview = runtime.factories.webhookResponse?.({
        ...context,
        previewRunId,
      });
      if (preview === undefined) throw new Error('Preview capability missing');
      expect(await preview.respond({ response, signal })).toEqual({
        outcome: 'preview',
        statusCode: 200,
      });
      expect(respond).toHaveBeenCalledTimes(1);
      await runtime.close();
      await expect(real.respond({ response, signal })).rejects.toThrow(
        'closed',
      );
    } finally {
      await runtime.close();
    }
  });

  it('fails closed for partially configured runtime capabilities', async () => {
    await expect(
      createOwnedCapabilities(
        { database: databaseConfig },
        {
          connectionStore: {
            resolveConnectionSecret: vi.fn(),
            assertConnectionSecretCurrent: vi.fn(),
          },
        },
      ),
    ).rejects.toThrow('Worker provider rate limiter is incomplete');
    await expect(
      createOwnedCapabilities(
        { database: databaseConfig },
        {
          connectionStore: {
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
      createOwnedCapabilities(
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
      const result = await createOwnedCapabilities(
        { database: databaseConfig, redisUrl: 'redis://localhost:6379/0' },
        {
          connectionStore: {
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
        createOwnedCapabilities(
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
    const runtime = await createOwnedCapabilities(
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
    const borrowing = () =>
      createOwnedCapabilities(
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
    try {
      await (await borrowing()).close();
      // A borrowed runtime stays open for the rest of the process, so the
      // next capabilities can still acquire it.
      const next = await borrowing();
      await next.close();
    } finally {
      await databaseRuntime.close();
    }
    await expect(borrowing()).rejects.toThrow(
      'Database runtime is closed and cannot be acquired',
    );
  });
}
