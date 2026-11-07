import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  type Browser,
} from '../support/better-auth/real-api.support.js';
import { password } from '../support/better-auth/api/environment.js';
import { createSocialSignInFixture } from './federation/social/fixture.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'one browser CSRF policy across transports',
  () => {
    const { api } = createSocialSignInFixture();
    let browser: Browser;
    beforeAll(async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      browser = await api.signIn(email);
    });
    const consumers = [
      {
        path: '/v1/workspaces',
        accepted: 201,
        payload: () => ({
          name: 'CSRF workspace',
          slug: `csrf-${randomUUID()}`,
        }),
      },
      {
        path: '/v1/auth/account-security/sessions/revoke',
        accepted: 200,
        payload: () => ({ sessionId: randomUUID() }),
      },
      {
        path: '/v1/auth/account-security/methods/link/start',
        accepted: 200,
        payload: () => ({
          provider: 'google',
          existingMethod: { kind: 'password', password },
        }),
      },
    ];
    for (const consumer of consumers) {
      it.each([
        ['malformed escape', '%', 'valid-csrf-token-at-least-16', 400],
        ['malformed UTF8', '%C0%AF', 'valid-csrf-token-at-least-16', 400],
        ['missing cookie', undefined, 'valid-csrf-token-at-least-16', 403],
        ['missing header', 'valid-csrf-token-at-least-16', undefined, 403],
        [
          'mismatch',
          'valid-csrf-token-at-least-16',
          'different-csrf-token-at-least-16',
          403,
        ],
      ] as const)(
        `${consumer.path} refuses %s`,
        async (_name, cookie, token, status) => {
          const response = await api.send('POST', consumer.path, {
            headers: {
              cookie: `pertexo_session=${browser.session}${cookie === undefined ? '' : `; pertexo_csrf=${cookie}`}`,
              ...(token === undefined ? {} : { 'x-csrf-token': token }),
            },
            payload: consumer.payload(),
          });
          expect(response.statusCode, response.payload).toBe(status);
        },
      );
      it.each(['issued', 'minimum', 'encoded'] as const)(
        `${consumer.path} accepts the %s proof`,
        async (kind) => {
          const token = kind === 'issued' ? browser.csrf : 'A'.repeat(16);
          const cookie = kind === 'encoded' ? `%41${token.slice(1)}` : token;
          const response = await api.send('POST', consumer.path, {
            headers: {
              cookie: `pertexo_session=${browser.session}; pertexo_csrf=${cookie}`,
              'x-csrf-token': token,
              'idempotency-key': randomUUID(),
            },
            payload: consumer.payload(),
          });
          expect(response.statusCode, response.payload).toBe(consumer.accepted);
        },
      );
    }
  },
);
