import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

import {
  DistributedRateLimiter,
  type DistributedRateLimitResult,
} from './distributed-rate-limiter.js';
import type { RateLimitDecision } from './policy.js';

export type RedisRateLimitRuntimeOptions = Readonly<{
  operationTimeoutMs?: number;
}>;

const DEFAULT_OPERATION_TIMEOUT_MS = 1_000;

export class RedisRateLimitRuntime {
  private readonly redis: Redis;
  private readonly limiter: DistributedRateLimiter;
  private readonly operationTimeoutMs: number;
  private connection: Promise<void> | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  public constructor(
    redisUrl: string,
    options: RedisRateLimitRuntimeOptions = {},
  ) {
    this.operationTimeoutMs = operationTimeout(options.operationTimeoutMs);
    this.redis = new Redis(redisUrl, {
      commandTimeout: this.operationTimeoutMs,
      connectTimeout: this.operationTimeoutMs,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    this.redis.on('error', () => undefined);
    this.limiter = new DistributedRateLimiter({
      eval: async (script, numberOfKeys, ...arguments_) => {
        return this.withDeadline(async () => {
          await this.connect();
          return this.redis.eval(script, numberOfKeys, ...arguments_);
        });
      },
    });
  }

  public consume(
    decision: RateLimitDecision,
  ): Promise<DistributedRateLimitResult> {
    return this.limiter.consume(decision);
  }

  /** A bounded exclusive slot shared by instances; a crash cannot retain it forever. */
  public async acquireExclusiveSlot(
    scope: string,
    ttlMs: number,
  ): Promise<{ release(): Promise<void> } | null> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 3_600_000)
      throw new RangeError(
        'Slot lifetime must be 1 through 3600000 milliseconds',
      );
    const key = `pertexo:admission:${createHash('sha256').update(scope).digest('hex')}`;
    const owner = randomUUID();
    const acquired = await this.withDeadline(async () => {
      await this.connect();
      return this.redis.eval(
        "return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])",
        1,
        key,
        owner,
        String(ttlMs),
      );
    });
    if (acquired === null) return null;
    if (acquired !== 'OK') throw new Error('Invalid concurrency slot result');
    return {
      release: () =>
        this.withDeadline(async () => {
          await this.connect();
          await this.redis.eval(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
            1,
            key,
            owner,
          );
        }),
    };
  }

  public close(): Promise<void> {
    this.closed = true;
    if (this.closePromise === undefined) {
      if (this.redis.status === 'ready')
        this.closePromise = Promise.resolve().then(() =>
          this.closeReadyClient(),
        );
      else
        this.closePromise = Promise.resolve().then(() => {
          this.redis.disconnect();
        });
    }
    return this.closePromise;
  }

  private async closeReadyClient(): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error('Redis rate-limit close timed out'));
      }, this.operationTimeoutMs);
      timeout.unref();
    });
    let failure: Error | undefined;
    try {
      await Promise.race([this.redis.quit(), deadline]);
    } catch (error) {
      failure = redisCloseError(error);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    try {
      this.redis.disconnect();
    } catch (error) {
      if (failure === undefined) throw redisCloseError(error);
    }
    if (failure !== undefined) throw failure;
  }

  private async connect(): Promise<void> {
    if (this.closed) throw new Error('Redis rate-limit runtime is closed');
    if (this.redis.status === 'ready') return;
    const connection =
      this.connection ?? this.redis.connect().then(() => undefined);
    this.connection = connection;
    try {
      await connection;
      if (this.isClosed()) {
        this.redis.disconnect();
        throw new Error('Redis rate-limit runtime is closed');
      }
    } finally {
      if (this.connection === connection) this.connection = undefined;
    }
  }

  private isClosed(): boolean {
    return this.closed;
  }

  private async withDeadline<T>(operation: () => Promise<T>): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        this.connection = undefined;
        this.redis.disconnect();
        reject(new Error('Redis rate-limit operation timed out'));
      }, this.operationTimeoutMs);
      timeout.unref();
    });
    try {
      return await Promise.race([operation(), deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

function redisCloseError(error: unknown): Error {
  try {
    if (error instanceof Error) return error;
  } catch {
    // Ignore hostile rejection values and retain them only as an opaque cause.
  }
  return new Error('Redis rate-limit close failed', { cause: error });
}

function operationTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 10_000)
    throw new TypeError(
      'Redis rate-limit operation timeout must be 100 through 10000 milliseconds',
    );
  return timeout;
}
