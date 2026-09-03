import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redisMock = vi.hoisted<{
  connect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  disconnect: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
  on: ReturnType<typeof vi.fn>;
  options: unknown;
  quit: ReturnType<typeof vi.fn<() => Promise<'OK'>>>;
  status: string;
}>(() => ({
  connect: vi.fn<() => Promise<void>>(),
  disconnect: vi.fn(),
  eval: vi.fn<() => Promise<unknown>>(),
  on: vi.fn(),
  options: undefined,
  quit: vi.fn<() => Promise<'OK'>>(),
  status: 'wait',
}));

vi.mock('ioredis', () => ({
  Redis: class {
    public constructor(_url: string, options: unknown) {
      redisMock.options = options;
    }
    public get status() {
      return redisMock.status;
    }
    public connect = redisMock.connect;
    public disconnect = redisMock.disconnect;
    public eval = redisMock.eval;
    public on = redisMock.on;
    public quit = redisMock.quit;
  },
}));

import { RedisRateLimitRuntime } from '../src/redis-runtime.js';

const decision = {
  endpointClass: 'ordinary_mutation',
  failureMode: 'closed',
  windowSeconds: 60,
  dimensions: [{ kind: 'actor', identifier: 'actor-a', limit: 10 }],
} as const;

describe('Redis rate-limit runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    redisMock.status = 'wait';
    redisMock.connect.mockReset();
    redisMock.disconnect.mockReset();
    redisMock.eval.mockReset();
    redisMock.on.mockReset();
    redisMock.quit.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies one bounded connect and command policy to the Redis client', () => {
    new RedisRateLimitRuntime('redis://example.test', {
      operationTimeoutMs: 250,
    });

    expect(redisMock.options).toMatchObject({
      commandTimeout: 250,
      connectTimeout: 250,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
  });

  it('bounds a stalled connect and resets the socket for the next decision', async () => {
    redisMock.connect.mockReturnValue(new Promise(() => undefined));
    const runtime = new RedisRateLimitRuntime('redis://example.test', {
      operationTimeoutMs: 100,
    });

    const consumed = runtime.consume(decision);
    const rejected = expect(consumed).rejects.toThrow(
      'Redis rate-limit operation timed out',
    );
    await vi.advanceTimersByTimeAsync(100);

    await rejected;
    expect(redisMock.disconnect).toHaveBeenCalledOnce();
  });

  it('bounds a stalled script within the same end-to-end deadline', async () => {
    redisMock.connect.mockResolvedValue(undefined);
    redisMock.eval.mockReturnValue(new Promise(() => undefined));
    const runtime = new RedisRateLimitRuntime('redis://example.test', {
      operationTimeoutMs: 100,
    });

    const consumed = runtime.consume(decision);
    const rejected = expect(consumed).rejects.toThrow(
      'Redis rate-limit operation timed out',
    );
    await vi.advanceTimersByTimeAsync(100);

    await rejected;
    expect(redisMock.disconnect).toHaveBeenCalledOnce();
  });

  it('rejects an operation budget outside the reviewed bounds', () => {
    expect(
      () =>
        new RedisRateLimitRuntime('redis://example.test', {
          operationTimeoutMs: 99,
        }),
    ).toThrow(/100 through 10000/u);
  });
});
