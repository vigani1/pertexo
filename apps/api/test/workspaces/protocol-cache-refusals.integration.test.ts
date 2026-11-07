import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';
import type { Browser } from '../support/better-auth/api/contract.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'private protocol refusal cache protection',
  () => {
    const api = useBetterAuthRealApi('protocol_cache', {
      automationTokens: true,
    });
    let browser: Browser;
    beforeAll(async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      browser = await api.signIn(email);
    });
    it.each([
      ['signed out', {}],
      ['invalid bearer', { authorization: 'Bearer invalid-credential' }],
      ['invalid session', { cookie: 'pertexo_session=invalid-credential' }],
    ] as const)(
      'protects token introspection when %s',
      async (_name, headers) => {
        const response = await api.send('GET', '/v1/token', { headers });
        expect(response.statusCode, response.payload).toBe(401);
        expect(response.headers['cache-control']).toBe('private, no-store');
      },
    );
    describe.each(['session', 'complete'])('invitation %s', (operation) => {
      const path = `/v1/invitation-acceptance/${operation}`;
      it.each([
        ['signed out', {}],
        ['invalid session', { cookie: 'pertexo_session=invalid-credential' }],
      ] as const)(
        'protects authentication refusal when %s',
        async (_name, headers) => {
          const response = await api.send('POST', path, {
            headers,
            payload: {},
          });
          expect(response.statusCode, response.payload).toBe(401);
          expect(response.headers['cache-control']).toBe('private, no-store');
        },
      );
      it('protects a CSRF refusal for an authenticated caller', async () => {
        const response = await api.send('POST', path, {
          browser,
          headers: { 'x-csrf-token': 'a'.repeat(43) },
          payload: {},
        });
        expect(response.statusCode, response.payload).toBe(403);
        expect(response.headers['cache-control']).toBe('private, no-store');
      });
    });
  },
);
