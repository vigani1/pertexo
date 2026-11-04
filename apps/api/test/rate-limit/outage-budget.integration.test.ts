import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit';
import { HttpRateLimitAdmission } from '../../src/platform/rate-limit/admission.js';
import { assertIntegrationGateConfigured } from '../support/integration-gate.js';

const redisUrl = process.env.REDIS_URL;
const requested = process.env.REDIS_RATE_LIMIT_INTEGRATION === 'true';
assertIntegrationGateConfigured({
  name: 'exhausted sign-in outage budget',
  requested,
  required: { REDIS_URL: redisUrl },
});

it.runIf(requested)(
  'limits an already-exhausted sign-in subject after its separate outage budget and keeps refusing within the outage',
  async () => {
    const redis = new RedisRateLimitRuntime(redisUrl ?? '', {
      operationTimeoutMs: 2_000,
    });
    let recovered: RedisRateLimitRuntime | undefined;
    const metrics = { record: () => undefined };
    const admission = new HttpRateLimitAdmission(redis, metrics);
    const identity = randomUUID().replaceAll('-', '');
    const subject = {
      clientAddress:
        '2001:db8:' +
        Array.from({ length: 6 }, (_, at) =>
          identity.slice(at * 4, at * 4 + 4),
        ).join(':'),
      account: identity + '@example.test',
    };
    const admit = () => admission.admit('identity_start', subject);
    try {
      for (let remaining = 9; remaining >= 0; remaining--)
        expect(await admit()).toMatchObject({ limit: 10, remaining });
      await expect(admit()).rejects.toMatchObject({
        code: 'request.rate_limited',
      });
      // A closed, real backend deterministically enters the same fallback as an outage.
      await redis.close();
      for (let remaining = 9; remaining >= 0; remaining--)
        expect(await admit()).toMatchObject({ limit: 10, remaining });
      for (let repeat = 0; repeat < 20; repeat++)
        await expect(admit()).rejects.toMatchObject({
          code: 'request.rate_limited',
          details: { retryAfterSeconds: expect.any(Number) as unknown },
        });
      recovered = new RedisRateLimitRuntime(redisUrl ?? '', {
        operationTimeoutMs: 2_000,
      });
      const restored = new HttpRateLimitAdmission(recovered, metrics);
      await expect(
        restored.admit('identity_start', subject),
      ).rejects.toMatchObject({ code: 'request.rate_limited' });
    } finally {
      await redis.close();
      await recovered?.close();
    }
  },
);
