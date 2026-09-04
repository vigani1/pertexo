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

  public close(): Promise<void> {
    this.closed = true;
    if (this.closePromise === undefined) {
      if (this.redis.status === 'ready')
        this.closePromise = this.redis.quit().then(() => undefined);
      else {
        this.redis.disconnect();
        this.closePromise = Promise.resolve();
      }
    }
    return this.closePromise;
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

function operationTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 10_000)
    throw new TypeError(
      'Redis rate-limit operation timeout must be 100 through 10000 milliseconds',
    );
  return timeout;
}
