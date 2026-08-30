import { Redis } from 'ioredis';

import {
  DistributedRateLimiter,
  type DistributedRateLimitResult,
} from './distributed-rate-limiter.js';
import type { RateLimitDecision } from './policy.js';

export class RedisRateLimitRuntime {
  private readonly redis: Redis;
  private readonly limiter: DistributedRateLimiter;
  private connection: Promise<void> | undefined;

  public constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    this.redis.on('error', () => undefined);
    this.limiter = new DistributedRateLimiter({
      eval: async (script, numberOfKeys, ...arguments_) => {
        await this.connect();
        return this.redis.eval(script, numberOfKeys, ...arguments_);
      },
    });
  }

  public consume(
    decision: RateLimitDecision,
  ): Promise<DistributedRateLimitResult> {
    return this.limiter.consume(decision);
  }

  public async close(): Promise<void> {
    if (this.redis.status === 'ready') await this.redis.quit();
    else this.redis.disconnect();
  }

  private async connect(): Promise<void> {
    if (this.redis.status === 'ready') return;
    this.connection ??= this.redis.connect().then(() => undefined);
    try {
      await this.connection;
    } catch (error: unknown) {
      this.connection = undefined;
      throw error;
    }
  }
}
