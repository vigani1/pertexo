import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  expectProblem,
} from '../../support/better-auth/real-api.support.js';
import { factorPassword } from '../../support/better-auth/two-factor.js';
import { createEnrollmentFixture } from './two-factor-sign-in.fixture.js';

// Review J6a final P2: the web pauses a page on auth.unauthenticated, so a
// mistyped code from someone still signed in must say what it is.
describe.skipIf(!betterAuthIntegrationEnabled)(
  'a refused code while signed in',
  () => {
    const { api } = createEnrollmentFixture();

    it('names a wrong enrollment code, not an ended session, and keeps the session', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      const browser = await api.signIn(email);
      const enabled = await api.send('POST', '/v1/auth/two-factor/enable', {
        browser,
        payload: { password: factorPassword },
      });
      expect(enabled.statusCode).toBe(200);
      expectProblem(
        await api.send('POST', '/v1/auth/two-factor/verify-totp', {
          browser,
          payload: { code: '000000' },
        }),
        401,
        'auth.two_factor_code_invalid',
      );
      const me = await api.send('GET', '/v1/users/me', { browser });
      expect(me.statusCode).toBe(200);
    });

    it('names a wrong password at sign-in as refused credentials', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      expectProblem(
        await api.send('POST', '/v1/auth/sign-in/email', {
          payload: { email, password: 'not the password at all' },
        }),
        401,
        'auth.invalid_credentials',
      );
    });
  },
);
