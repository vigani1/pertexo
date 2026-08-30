import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DistributedRateLimiter,
  type RateLimitDecision,
} from '@pertexo/rate-limit';
import { assertIntegrationGateConfigured } from '../support/integration-gate.js';

const redisUrl = process.env.REDIS_URL;
const requested = process.env.REDIS_RATE_LIMIT_INTEGRATION === 'true';
assertIntegrationGateConfigured({
  name: 'distributed abuse rate limit integration',
  requested,
  required: { REDIS_URL: redisUrl },
});
const describeIntegration = requested ? describe : describe.skip;

describeIntegration('distributed abuse rate limit integration', () => {
  let redis: Redis;
  let limiter: DistributedRateLimiter;

  beforeAll(async () => {
    redis = new Redis(redisUrl ?? '', {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    await redis.connect();
    await redis.ping();
    limiter = new DistributedRateLimiter(redis);
  });

  afterAll(async () => {
    if (redis.status === 'ready') await redis.quit();
    else redis.disconnect();
  });

  it('enforces an exact concurrent threshold and recovers after the window', async () => {
    const decision: RateLimitDecision = {
      endpointClass: 'ordinary_mutation',
      failureMode: 'closed',
      windowSeconds: 1,
      dimensions: [{ kind: 'actor', identifier: randomUUID(), limit: 10 }],
    };

    const results = await Promise.all(
      Array.from({ length: 25 }, () => limiter.consume(decision)),
    );
    expect(results.filter(({ allowed }) => allowed)).toHaveLength(10);
    expect(results.filter(({ allowed }) => !allowed)).toHaveLength(15);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(limiter.consume(decision)).resolves.toEqual({ allowed: true });
  });
});
