import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RedisRateLimitRuntime } from '@pertexo/rate-limit';
import type { RateLimitDecision } from '@pertexo/rate-limit';
import { assertIntegrationGateConfigured } from '../support/integration-gate.js';
import type { FixtureRedisProxy } from '../support/rate-limit-integration-fixture.js';
import {
  cleanupRedisRateLimitFixture,
  initializeRedisRateLimitFixture,
} from '../support/rate-limit-integration-fixture.js';

const redisUrl = process.env.REDIS_URL;
const requested = process.env.REDIS_RATE_LIMIT_INTEGRATION === 'true';
assertIntegrationGateConfigured({
  name: 'distributed abuse rate limit integration',
  requested,
  required: { REDIS_URL: redisUrl },
});
const describeIntegration = requested ? describe : describe.skip;

describeIntegration('distributed abuse rate limit integration', () => {
  let control: Redis | undefined;
  let sentinel: Redis | undefined;
  let limiter: RedisRateLimitRuntime | undefined;
  let proxy: FixtureRedisProxy | undefined;

  beforeAll(async () => {
    const initialized = await initializeRedisRateLimitFixture(redisUrl ?? '');
    ({ control, limiter, proxy, sentinel } = initialized);
  });

  afterAll(async () => {
    const cleanupErrors = await cleanupRedisRateLimitFixture({
      control,
      limiter,
      proxy,
      sentinel,
    });
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        cleanupErrors,
        'Rate-limit integration cleanup failed',
      );
  });

  it('recovers the production runtime after its fixture-owned proxy drops only its connection', async () => {
    const beforeDrop: RateLimitDecision = {
      endpointClass: 'ordinary_mutation',
      failureMode: 'closed',
      windowSeconds: 60,
      dimensions: [{ kind: 'actor', identifier: randomUUID(), limit: 1 }],
    };
    const selectedLimiter = requireLimiter(limiter);
    const selectedProxy = requireProxy(proxy);
    const selectedSentinel = requireRedis(sentinel, 'sentinel');
    await expect(selectedLimiter.consume(beforeDrop)).resolves.toEqual({
      allowed: true,
    });
    await expect.poll(() => selectedProxy.connectionCount).toBe(1);
    await expect(selectedSentinel.ping()).resolves.toBe('PONG');

    expect(selectedProxy.disconnectClients()).toBe(1);
    await expect(selectedSentinel.ping()).resolves.toBe('PONG');

    const afterDrop: RateLimitDecision = {
      ...beforeDrop,
      dimensions: [{ kind: 'actor', identifier: randomUUID(), limit: 1 }],
    };
    await expect
      .poll(async () => selectedLimiter.consume(afterDrop), { timeout: 5_000 })
      .toEqual({ allowed: true });
    await expect(selectedSentinel.ping()).resolves.toBe('PONG');
  });

  it('enforces an exact concurrent threshold and recovers after the window', async () => {
    const decision: RateLimitDecision = {
      endpointClass: 'ordinary_mutation',
      failureMode: 'closed',
      windowSeconds: 1,
      dimensions: [{ kind: 'actor', identifier: randomUUID(), limit: 10 }],
    };
    const selectedLimiter = requireLimiter(limiter);
    const results = await Promise.all(
      Array.from({ length: 25 }, () => selectedLimiter.consume(decision)),
    );
    expect(results.filter(({ allowed }) => allowed)).toHaveLength(10);
    expect(results.filter(({ allowed }) => !allowed)).toHaveLength(15);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(selectedLimiter.consume(decision)).resolves.toEqual({
      allowed: true,
    });
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
    const selectedLimiter = requireLimiter(limiter);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => selectedLimiter.consume(decision)),
    );
    expect(results.filter(({ allowed }) => allowed)).toHaveLength(2);
    expect(results.filter(({ allowed }) => !allowed)).toHaveLength(3);
  });

  it('preserves quiet-tenant admission under representative noisy load', async () => {
    const noisyDecision: RateLimitDecision = {
      endpointClass: 'run_admission',
      failureMode: 'closed',
      windowSeconds: 60,
      dimensions: [{ kind: 'workspace', identifier: randomUUID(), limit: 50 }],
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
    const selectedLimiter = requireLimiter(limiter);
    const startedAt = performance.now();
    const [noisyResults, quietResults] = await Promise.all([
      Promise.all(
        Array.from({ length: 500 }, () =>
          selectedLimiter.consume(noisyDecision),
        ),
      ),
      Promise.all(
        quietDecisions.map((entry) => selectedLimiter.consume(entry)),
      ),
    ]);

    expect(noisyResults.filter(({ allowed }) => allowed)).toHaveLength(50);
    expect(quietResults.every(({ allowed }) => allowed)).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(10_000);
  });
});

function requireLimiter(
  value: RedisRateLimitRuntime | undefined,
): RedisRateLimitRuntime {
  if (value === undefined)
    throw new Error('Rate-limit fixture was not initialized');
  return value;
}

function requireProxy(value: FixtureRedisProxy | undefined): FixtureRedisProxy {
  if (value === undefined)
    throw new Error('Redis fault proxy was not initialized');
  return value;
}

function requireRedis(value: Redis | undefined, label: string): Redis {
  if (value === undefined)
    throw new Error(`${label} Redis client was not initialized`);
  return value;
}
