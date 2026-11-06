import { randomUUID } from 'node:crypto';

import {
  LocalRateLimiter,
  RedisRateLimitRuntime,
} from '@pertexo/rate-limit/server';
import type { RateLimitDecision } from '@pertexo/rate-limit/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertIntegrationGateConfigured } from '../support/integration-gate.js';

const redisUrl = process.env.REDIS_URL;
const requested = process.env.REDIS_RATE_LIMIT_INTEGRATION === 'true';
assertIntegrationGateConfigured({
  name: 'local and Redis limit parity',
  requested,
  required: { REDIS_URL: redisUrl },
});

type Step = Readonly<{
  client: string;
  account?: string;
  limits: readonly [number, number];
}>;

/**
 * Compare counters that start together under the same increment/refusal rule.
 * Redis admissions before an outage are absent from the fallback's independent
 * window; the outage-budget regression covers that transition.
 */
describe.runIf(requested)('the limit kept while Redis is out', () => {
  let redis: RedisRateLimitRuntime;

  beforeAll(() => {
    redis = new RedisRateLimitRuntime(redisUrl ?? '', {
      operationTimeoutMs: 2_000,
    });
  });

  afterAll(async () => {
    await redis.close();
  });

  const decide = (scope: string, step: Step): RateLimitDecision => ({
    endpointClass: 'identity_start',
    failureMode: 'closed',
    // The policy's only window: Redis's answer caps its wait at this, the local one
    // doesn't, and no real decision can tell them apart.
    windowSeconds: 60,
    dimensions: [
      {
        kind: 'client_address',
        identifier: `${scope}-${step.client}`,
        limit: step.limits[0],
      },
      ...(step.account === undefined
        ? []
        : [
            {
              kind: 'account' as const,
              identifier: `${scope}-${step.account}`,
              limit: step.limits[1],
            },
          ]),
    ],
  });

  const repeat = (times: number, step: Step): readonly Step[] =>
    Array.from({ length: times }, () => step);

  const SEQUENCES: Readonly<Record<string, readonly Step[]>> = {
    'one client past its limit': repeat(5, { client: 'a', limits: [3, 3] }),
    'an account past its limit, and a client still under': repeat(5, {
      client: 'a',
      account: 'x',
      limits: [10, 2],
    }),
    'a client past its limit, and an account still under': repeat(5, {
      client: 'a',
      account: 'x',
      limits: [2, 10],
    }),
    'several addresses on one account': [
      ...repeat(2, { client: 'a', account: 'x', limits: [5, 3] }),
      ...repeat(3, { client: 'b', account: 'x', limits: [5, 3] }),
    ],
    // A refused request counts on neither, so the client's count stays where it was.
    'refusals leave the other dimension alone': [
      ...repeat(4, { client: 'a', account: 'x', limits: [3, 1] }),
      ...repeat(3, { client: 'a', limits: [3, 1] }),
    ],
  };

  it.each(Object.keys(SEQUENCES))('answers the same for %s', async (name) => {
    const scope = randomUUID();
    const local = new LocalRateLimiter();
    const shape = (result: Awaited<ReturnType<typeof redis.consume>>) =>
      result.allowed
        ? { allowed: true }
        : { allowed: false, limitedDimension: result.limitedDimension };
    const waits: number[][] = [];

    const fromRedis: unknown[] = [];
    const fromLocal: unknown[] = [];
    for (const step of SEQUENCES[name] ?? []) {
      const selected = decide(scope, step);
      const redisAnswer = await redis.consume(selected);
      const localAnswer = local.consume(selected);
      fromRedis.push(shape(redisAnswer));
      fromLocal.push(shape(localAnswer));
      if (!redisAnswer.allowed && !localAnswer.allowed)
        waits.push([
          redisAnswer.retryAfterSeconds,
          localAnswer.retryAfterSeconds,
        ]);
    }

    expect(fromLocal).toEqual(fromRedis);
    expect(waits.length).toBeGreaterThan(0);
    // Their clocks started a moment apart, and each rounds up to a second.
    for (const [fromRedisWait = 0, fromLocalWait = 0] of waits)
      expect(Math.abs(fromRedisWait - fromLocalWait)).toBeLessThanOrEqual(1);
  });
});
