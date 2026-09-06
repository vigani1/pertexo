import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RedisRateLimitRuntime,
  type RateLimitDecision,
  type RateLimitDimensionKind,
} from '@pertexo/rate-limit';
import { assertIntegrationGateConfigured } from '../support/integration-gate.js';

const redisUrl = process.env.REDIS_URL;
const requested = process.env.REDIS_RATE_LIMIT_INTEGRATION === 'true';
assertIntegrationGateConfigured({
  name: 'multidimensional rate-limit integration',
  requested,
  required: { REDIS_URL: redisUrl },
});
const describeIntegration = requested ? describe : describe.skip;
const kinds = [
  'client_address',
  'origin',
  'actor',
  'workspace',
  'connection',
] as const;

function decision(
  dimensions: RateLimitDecision['dimensions'],
): RateLimitDecision {
  return {
    endpointClass: 'ordinary_mutation',
    failureMode: 'closed',
    windowSeconds: 60,
    dimensions,
  };
}

describeIntegration('atomic multidimensional distributed admission', () => {
  let limiter: RedisRateLimitRuntime;
  beforeAll(() => {
    limiter = new RedisRateLimitRuntime(redisUrl ?? '', {
      operationTimeoutMs: 2_000,
    });
  });
  afterAll(async () => {
    await limiter.close();
  });

  it.each(kinds)(
    'rejecting the %s counter leaves every other counter uncharged',
    async (limitedKind: RateLimitDimensionKind) => {
      const dimensions = kinds.map((kind) => ({
        kind,
        identifier: randomUUID(),
        limit: kind === limitedKind ? 1 : 2,
      }));
      const limited = dimensions.find(({ kind }) => kind === limitedKind);
      if (limited === undefined) throw new Error('Missing limiting dimension');
      await expect(limiter.consume(decision([limited]))).resolves.toEqual({
        allowed: true,
      });
      const rejected = await Promise.all(
        Array.from({ length: 40 }, () => limiter.consume(decision(dimensions))),
      );
      for (const result of rejected) {
        expect(result).toMatchObject({
          allowed: false,
          limitedDimension: limitedKind,
        });
        if (result.allowed)
          throw new Error('Combined admission unexpectedly succeeded');
        expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
      }
      for (const dimension of dimensions.filter(
        ({ kind }) => kind !== limitedKind,
      )) {
        const probes = await Promise.all(
          Array.from({ length: 3 }, () =>
            limiter.consume(decision([dimension])),
          ),
        );
        expect(probes.filter(({ allowed }) => allowed)).toHaveLength(2);
        expect(probes.filter(({ allowed }) => !allowed)).toHaveLength(1);
      }
    },
  );

  it('charges all counters exactly once for each concurrent accepted request', async () => {
    const dimensions = kinds.map((kind) => ({
      kind,
      identifier: randomUUID(),
      limit: kind === 'connection' ? 4 : 8,
    }));
    const results = await Promise.all(
      Array.from({ length: 40 }, () => limiter.consume(decision(dimensions))),
    );
    expect(results.filter(({ allowed }) => allowed)).toHaveLength(4);
    expect(results.filter(({ allowed }) => !allowed)).toHaveLength(36);
    for (const dimension of dimensions) {
      const probes = await Promise.all(
        Array.from({ length: 5 }, () => limiter.consume(decision([dimension]))),
      );
      expect(probes.filter(({ allowed }) => allowed)).toHaveLength(
        dimension.limit - 4,
      );
    }
  });
});
