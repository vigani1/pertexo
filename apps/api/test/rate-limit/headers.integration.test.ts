import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';
import { FixtureRedisProxy } from './integration.fixture.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'honest HTTP budgets during a Redis read outage',
  () => {
    let proxy: FixtureRedisProxy;
    const options: { redisUrl?: string } = {};
    beforeAll(async () => {
      proxy = await FixtureRedisProxy.create(process.env.REDIS_URL ?? '');
      options.redisUrl = proxy.url;
    });
    const api = useBetterAuthRealApi('rate_headers', options);
    afterAll(async () => {
      await proxy.close();
    });
    it('omits quota headers when the real read limiter failed open', async () => {
      const email = `rate-headers-${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      const browser = await api.signIn(email);
      const before = await api.send('GET', '/v1/users/me', { browser });
      expect(before.statusCode, before.payload).toBe(200);
      expect(Number(before.headers['ratelimit-limit'])).toBeGreaterThan(0);
      expect(
        Number(before.headers['ratelimit-remaining']),
      ).toBeGreaterThanOrEqual(0);
      await proxy.close();
      const after = await api.send('GET', '/v1/users/me', { browser });
      expect(after.statusCode, after.payload).toBe(200);
      for (const name of [
        'ratelimit-limit',
        'ratelimit-remaining',
        'ratelimit-reset',
      ])
        expect(after.headers[name]).toBeUndefined();
    });
  },
);
