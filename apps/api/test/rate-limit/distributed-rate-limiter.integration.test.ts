import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  RedisRateLimitRuntime,
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
  let limiter: RedisRateLimitRuntime;

  beforeAll(async () => {
    redis = new Redis(redisUrl ?? '', {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    await redis.connect();
    await redis.ping();
    limiter = new RedisRateLimitRuntime(redisUrl ?? '', {
      operationTimeoutMs: 2_000,
    });
  });

  afterAll(async () => {
    await limiter.close();
    if (redis.status === 'ready') await redis.quit();
    else redis.disconnect();
  });

  it('recovers the production runtime after Redis drops its connection', async () => {
    const beforeDrop: RateLimitDecision = {
      endpointClass: 'ordinary_mutation',
      failureMode: 'closed',
      windowSeconds: 60,
      dimensions: [{ kind: 'actor', identifier: randomUUID(), limit: 1 }],
    };
    await expect(limiter.consume(beforeDrop)).resolves.toEqual({
      allowed: true,
    });

    const killed = await redis.call(
      'CLIENT',
      'KILL',
      'TYPE',
      'normal',
      'SKIPME',
      'yes',
    );
    expect(Number(killed)).toBeGreaterThanOrEqual(1);

    const afterDrop: RateLimitDecision = {
      ...beforeDrop,
      dimensions: [{ kind: 'actor', identifier: randomUUID(), limit: 1 }],
    };
    await expect
      .poll(async () => limiter.consume(afterDrop), { timeout: 5_000 })
      .toEqual({ allowed: true });
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

    // Exercise Redis's real expiry boundary, which is the distributed source
    // of truth rather than an application-injected clock.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(limiter.consume(decision)).resolves.toEqual({ allowed: true });
  });

  it.each([
    'client_address',
    'origin',
    'actor',
    'workspace',
    'connection',
  ] as const)('enforces the exact %s dimension threshold', async (kind) => {
    const decision: RateLimitDecision = {
      endpointClass: 'ordinary_mutation',
      failureMode: 'closed',
      windowSeconds: 60,
      dimensions: [{ kind, identifier: randomUUID(), limit: 2 }],
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => limiter.consume(decision)),
    );
    expect(results.filter(({ allowed }) => allowed)).toHaveLength(2);
    expect(results.filter(({ allowed }) => !allowed)).toHaveLength(3);
  });

  it('preserves quiet-tenant admission under representative noisy load', async () => {
    const noisyWorkspace = randomUUID();
    const noisyDecision: RateLimitDecision = {
      endpointClass: 'run_admission',
      failureMode: 'closed',
      windowSeconds: 60,
      dimensions: [
        { kind: 'workspace', identifier: noisyWorkspace, limit: 50 },
      ],
    };
    const quietDecisions: RateLimitDecision[] = Array.from(
      { length: 50 },
      () => ({
        endpointClass: 'run_admission',
        failureMode: 'closed',
        windowSeconds: 60,
        dimensions: [
          { kind: 'workspace' as const, identifier: randomUUID(), limit: 1 },
        ],
      }),
    );

    const startedAt = performance.now();
    const [noisyResults, quietResults] = await Promise.all([
      Promise.all(
        Array.from({ length: 500 }, () => limiter.consume(noisyDecision)),
      ),
      Promise.all(quietDecisions.map((entry) => limiter.consume(entry))),
    ]);
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(noisyResults.filter(({ allowed }) => allowed)).toHaveLength(50);
    expect(quietResults.every(({ allowed }) => allowed)).toBe(true);
    expect(elapsedMilliseconds).toBeLessThan(10_000);
    expect(elapsedMilliseconds / 550).toBeLessThan(20);
  });
});
