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

  it('deduplicates concurrent connects and reconnects after a disconnect', async () => {
    redisMock.connect.mockImplementation(() => {
      redisMock.status = 'ready';
      return Promise.resolve();
    });
    redisMock.eval.mockResolvedValue([1, 0, 0]);
    const runtime = new RedisRateLimitRuntime('redis://example.test');

    await Promise.all([runtime.consume(decision), runtime.consume(decision)]);
    expect(redisMock.connect).toHaveBeenCalledOnce();

    redisMock.status = 'end';
    await expect(runtime.consume(decision)).resolves.toEqual({ allowed: true });
    expect(redisMock.connect).toHaveBeenCalledTimes(2);
  });

  it('recovers from an initial connect rejection and never reconnects after close', async () => {
    redisMock.connect
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockImplementationOnce(() => {
        redisMock.status = 'ready';
        return Promise.resolve();
      });
    redisMock.eval.mockResolvedValue([1, 0, 0]);
    redisMock.quit.mockImplementation(() => {
      redisMock.status = 'end';
      return Promise.resolve('OK');
    });
    const runtime = new RedisRateLimitRuntime('redis://example.test');

    await expect(runtime.consume(decision)).rejects.toThrow(
      'redis unavailable',
    );
    await expect(runtime.consume(decision)).resolves.toEqual({ allowed: true });
    await runtime.close();
    await expect(runtime.consume(decision)).rejects.toThrow(/closed/iu);
    expect(redisMock.connect).toHaveBeenCalledTimes(2);
  });

  it('fails an in-flight connect when shutdown wins the race', async () => {
    let finishConnect: (() => void) | undefined;
    redisMock.connect.mockReturnValue(
      new Promise<void>((resolve) => {
        finishConnect = resolve;
      }),
    );
    const runtime = new RedisRateLimitRuntime('redis://example.test');

    const consumed = runtime.consume(decision);
    await runtime.close();
    finishConnect?.();

    await expect(consumed).rejects.toThrow(/closed/iu);
    expect(redisMock.disconnect).toHaveBeenCalledTimes(2);
    expect(redisMock.eval).not.toHaveBeenCalled();
  });

  it.each([99, 10_001, 100.5, Number.POSITIVE_INFINITY])(
    'rejects the invalid operation budget %s',
    (operationTimeoutMs) => {
      expect(
        () =>
          new RedisRateLimitRuntime('redis://example.test', {
            operationTimeoutMs,
          }),
      ).toThrow(/100 through 10000/u);
    },
  );
});
