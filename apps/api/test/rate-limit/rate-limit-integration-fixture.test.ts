import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import type { FixtureRedisProxy } from '../support/rate-limit-integration-fixture.js';
import { initializeRedisRateLimitFixture } from '../support/rate-limit-integration-fixture.js';

describe('rate-limit integration fixture ownership', () => {
  it('preserves allocation failure before acquiring a socket', async () => {
    const failure = new Error('allocation failed');
    const createProxy = vi.fn();

    await expect(
      initializeRedisRateLimitFixture('redis://fixture', {
        createLimiter: vi.fn(),
        createProxy,
        createRedis: vi.fn(() => {
          throw failure;
        }),
      }),
    ).rejects.toBe(failure);
    expect(createProxy).not.toHaveBeenCalled();
  });

  it.each(['connect', 'ping'] as const)(
    'closes a partially acquired control client after %s failure',
    async (boundary) => {
      const failure = new Error(`${boundary} failed`);
      const disconnect = vi.fn();
      const quit = vi.fn().mockResolvedValue('OK');
      const redis = redisOwner({
        status: boundary === 'ping' ? 'ready' : 'wait',
        connect:
          boundary === 'connect'
            ? vi.fn().mockRejectedValue(failure)
            : vi.fn().mockResolvedValue(undefined),
        ping:
          boundary === 'ping'
            ? vi.fn().mockRejectedValue(failure)
            : vi.fn().mockResolvedValue('PONG'),
        disconnect,
        quit,
      });

      await expect(
        initializeRedisRateLimitFixture('redis://fixture', {
          createLimiter: vi.fn(),
          createProxy: vi.fn(),
          createRedis: vi.fn(() => redis),
        }),
      ).rejects.toBe(failure);
      if (boundary === 'ping') expect(quit).toHaveBeenCalledOnce();
      else expect(disconnect).toHaveBeenCalledOnce();
    },
  );

  it('closes every acquired owner when limiter construction fails', async () => {
    const failure = new Error('limiter construction failed');
    const controlQuit = vi.fn().mockResolvedValue('OK');
    const sentinelQuit = vi.fn().mockResolvedValue('OK');
    const control = redisOwner({ status: 'ready', quit: controlQuit });
    const sentinel = redisOwner({ status: 'ready', quit: sentinelQuit });
    const proxyClose = vi.fn().mockResolvedValue(undefined);
    const proxy = {
      close: proxyClose,
      url: 'redis://127.0.0.1:43123',
    } as unknown as FixtureRedisProxy;
    const redisOwners = [control, sentinel];

    await expect(
      initializeRedisRateLimitFixture('redis://fixture', {
        createLimiter: vi.fn(() => {
          throw failure;
        }),
        createProxy: vi.fn().mockResolvedValue(proxy),
        createRedis: vi.fn(() => {
          const owner = redisOwners.shift();
          if (owner === undefined) throw new Error('unexpected allocation');
          return owner;
        }),
      }),
    ).rejects.toBe(failure);
    expect(proxyClose).toHaveBeenCalledOnce();
    expect(controlQuit).toHaveBeenCalledOnce();
    expect(sentinelQuit).toHaveBeenCalledOnce();
  });

  it('retains setup failure first and every cleanup failure in owner order', async () => {
    const setupFailure = new Error('limiter failed');
    const sentinelFailure = new Error('sentinel close failed');
    const controlFailure = new Error('control close failed');
    const control = redisOwner({
      status: 'ready',
      quit: vi.fn().mockRejectedValue(controlFailure),
    });
    const sentinel = redisOwner({
      status: 'ready',
      quit: vi.fn().mockRejectedValue(sentinelFailure),
    });
    const proxy = {
      close: vi.fn().mockRejectedValue(undefined),
      url: 'redis://127.0.0.1:43123',
    } as unknown as FixtureRedisProxy;
    const redisOwners = [control, sentinel];

    const result = await initializeRedisRateLimitFixture('redis://fixture', {
      createLimiter: () => {
        throw setupFailure;
      },
      createProxy: () => Promise.resolve(proxy),
      createRedis: () => {
        const owner = redisOwners.shift();
        if (owner === undefined) throw new Error('unexpected allocation');
        return owner;
      },
    }).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([
      setupFailure,
      undefined,
      sentinelFailure,
      controlFailure,
    ]);
  });
});

function redisOwner(
  overrides: Partial<Redis> & { status: Redis['status'] },
): Redis {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue('OK'),
    ...overrides,
  } as unknown as Redis;
}
