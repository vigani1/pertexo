import { describe, expect, it } from 'vitest';

import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../../support/better-auth/real-api.support.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'Better Auth fixture rate-limit isolation',
  () => {
    // Identical suite names, origins and client addresses still represent
    // separate applications, just like parallel integration files.
    const first = useBetterAuthRealApi('rate_isolation');
    const second = useBetterAuthRealApi('rate_isolation');

    it('keeps each parallel fixture independent while enforcing its real account limit', async () => {
      const results = await Promise.all(
        [first, second].map(async (api) => {
          const statuses: number[] = [];
          for (let request = 0; request < 21; request += 1) {
            // Invalid credentials exercise the real handler and limiter
            // without creating users or sending authentication mail.
            const response = await api.send('POST', '/v1/auth/sign-in/email', {
              payload: { email: 'rate-isolation@example.test' },
            });
            statuses.push(response.statusCode);
            if (response.statusCode === 429)
              expect(response.json()).toMatchObject({
                code: 'request.rate_limited',
                title: 'Too many authentication requests',
              });
          }
          return statuses;
        }),
      );
      for (const statuses of results) {
        expect(statuses.slice(0, 20)).toEqual(Array<number>(20).fill(400));
        expect(statuses[20]).toBe(429);
      }
    });
  },
);
