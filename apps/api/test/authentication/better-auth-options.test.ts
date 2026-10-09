import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { LocalAuthenticationMailSink } from '../../src/authentication/mail/delivery.js';
import { createPertexoBetterAuth } from '../../src/authentication/better-auth/options.js';
import type { OwnedEmailProofs } from '../../src/authentication/mail/email-proofs.js';

// Never connected: building the auth context reads no database.
const pool = new Pool({
  connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused',
});

afterAll(() => pool.end());

describe('Better Auth session cookie', () => {
  it.each([true, false])(
    'keeps the name the guards read when secure=%s',
    async (secureCookies) => {
      const auth = createPertexoBetterAuth({
        pool,
        baseUrl: secureCookies
          ? 'https://app.example.test'
          : 'http://127.0.0.1:5173',
        secret: 'cookie-policy-secret-with-at-least-32-characters',
        secureCookies,
        sessionTtlSeconds: 3_600,
        trustedOrigins: [],
        mail: new LocalAuthenticationMailSink(),
        emailProofs: {} as OwnedEmailProofs,
        availableLinkProviders: [],
      });

      const { sessionToken } = (await auth.$context).authCookies;
      expect(sessionToken.name).toBe('pertexo_session');
      expect(sessionToken.attributes.secure).toBe(secureCookies);
    },
  );
});
