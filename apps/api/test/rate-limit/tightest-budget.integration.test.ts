import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import {
  DistributedRateLimiter,
  LocalRateLimiter,
  type RateLimitDecision,
} from '@pertexo/rate-limit/server';

describe.runIf(process.env.REDIS_RATE_LIMIT_INTEGRATION === 'true')(
  'remaining budgets from real Lua and local admission',
  () => {
    it.each(['redis', 'local'] as const)(
      'reports the tightest remaining dimension even when it has a larger limit: %s',
      async (kind) => {
        const redis = new Redis(process.env.REDIS_URL ?? '');
        const namespace = randomUUID();
        const decision: RateLimitDecision = {
          endpointClass: 'authenticated_read',
          failureMode: 'open',
          windowSeconds: 60,
          dimensions: [
            { kind: 'actor', identifier: `${namespace}:actor`, limit: 10 },
            {
              kind: 'workspace',
              identifier: `${namespace}:workspace`,
              limit: 20,
            },
          ],
        };
        const limiter =
          kind === 'redis'
            ? new DistributedRateLimiter(redis)
            : new LocalRateLimiter();
        try {
          for (let i = 0; i < 18; i++)
            await limiter.consume({
              ...decision,
              dimensions: decision.dimensions.slice(1),
            });
          const reply = await limiter.consume(decision);
          expect(reply).toMatchObject({
            allowed: true,
            quota: { limit: 20, remaining: 1 },
          });
          if (reply.allowed)
            expect(reply.quota?.resetSeconds).toBeGreaterThan(0);
          expect(await limiter.consume(decision)).toMatchObject({
            allowed: true,
            quota: { limit: 20, remaining: 0 },
          });
          expect(await limiter.consume(decision)).toMatchObject({
            allowed: false,
            limitedDimension: 'workspace',
          });
        } finally {
          // Unique identities expire naturally; DB0 also holds peers' leases.
          redis.disconnect();
        }
      },
    );
  },
);
