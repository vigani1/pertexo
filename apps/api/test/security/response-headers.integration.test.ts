import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { betterAuthIntegrationEnabled } from '../support/better-auth/real-api.support.js';
import type { Reply, Stack } from './stack.js';

/** The policy for a response that is data, never a page. */
function expectLockedDown(path: string, reply: Reply): void {
  const policy = reply.headers.get('content-security-policy') ?? '';
  expect(policy, path).toMatch(/default-src 'none'/u);
  expect(policy, path).toMatch(/frame-ancestors 'none'/u);
  expect(reply.headers.get('x-content-type-options'), path).toBe('nosniff');
}

describe.runIf(betterAuthIntegrationEnabled)(
  'security headers on real API responses',
  () => {
    let stack: Stack;

    beforeAll(async () => {
      const { startStack } = await import('./stack.js');
      stack = await startStack({
        environment: { AUTH_SIGN_UP_MODE: 'open' },
      });
    }, 120_000);
    afterAll(async () => {
      await stack.close();
    }, 60_000);

    // sec-04: /hooks and /v1/auth reach the API without passing nginx.
    it.fails.each([
      ['GET', '/v1/auth/capabilities'],
      ['GET', '/v1/auth/verify-email?token=not-a-real-token'],
      ['POST', '/hooks/not-a-real-endpoint-key'],
      ['GET', '/hooks/not-a-real-endpoint-key'],
      ['GET', '/v1/users/me'],
      ['GET', '/v1/no-such-route'],
      ['POST', '/v1/notifications/unsubscribe/one-click'],
    ])('locks down %s %s', async (method, path) => {
      expectLockedDown(path, await stack.send(method, path));
    });
  },
);
