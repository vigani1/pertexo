import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  browserFrom,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'authentication trailing slashes through the real bridge',
  () => {
    const api = useBetterAuthRealApi('auth_slashes');
    it('keeps sign-up, proof query parameters, sign-in and security routes working with a trailing slash', async () => {
      const email = `slash-${randomUUID()}@example.test`,
        password = 'a long enough integration password';
      const signup = await api.send('POST', '/v1/auth/sign-up/email/', {
        payload: {
          name: 'Slash Person',
          email,
          password,
          callbackURL: '/workspaces',
        },
      });
      expect(signup.statusCode, signup.payload).toBe(200);
      const link = api.mailedLink(email, 'verification');
      const verification = await api.send(
        'GET',
        link.pathname + '/' + link.search,
      );
      expect(verification.statusCode, verification.payload).toBe(302);
      expect(verification.headers.location).not.toContain(
        'verification_invalid',
      );
      const signin = await api.send('POST', '/v1/auth/sign-in/email/', {
        payload: { email, password },
      });
      expect(signin.statusCode, signin.payload).toBe(200);
      const browser = browserFrom(signin);
      expect(
        (await api.send('GET', '/v1/auth/account-security/', { browser }))
          .statusCode,
      ).toBe(200);
      expect(
        (await api.send('GET', '/v1/auth/get-session/', { browser }))
          .statusCode,
      ).toBe(404);
    });
  },
);
