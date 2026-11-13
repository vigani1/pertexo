import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { AccountLinking } from '../../../src/authentication/account-security/account-linking.js';
import { normalizedNativeError } from '../../../src/authentication/better-auth/transport/authentication-problems.js';
import type { SocialProviderGateway } from '../../../src/authentication/social-provider.types.js';

const csrf = 'link-start-csrf-token-1234';

/** Link start as the browser reaches it, answered in the bridge's words. */
async function startLink(emailVerified: boolean) {
  const linking = new AccountLinking({
    // Neither refusal reaches the database.
    pool: {} as Pool,
    secret: 'link-start-secret-at-least-32-characters',
    baseUrl: 'http://pertexo.test',
    secureCookies: false,
    sessionTtlSeconds: 3_600,
    providers: { available: ['google'] } as unknown as SocialProviderGateway,
    authenticate: () =>
      Promise.resolve({
        userId: 'user-1',
        sessionId: 'session-1',
        emailVerified,
      }),
    verifyPassword: () => Promise.resolve(false),
    deliver: () => Promise.resolve([]),
  });
  const response = await linking.handle(
    new Request(
      'http://pertexo.test/v1/auth/account-security/methods/link/start',
      {
        method: 'POST',
        headers: {
          cookie: `pertexo_csrf=${csrf}`,
          'x-csrf-token': csrf,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'google',
          existingMethod: { kind: 'password', password: 'wrong password' },
        }),
      },
    ),
  );
  if (response === undefined) throw new Error('link start was not handled');
  const answer = normalizedNativeError(
    response.status,
    new Uint8Array(await response.arrayBuffer()),
    'link-start',
  );
  return {
    status: answer.status,
    code: (JSON.parse(answer.body) as { code: string }).code,
  };
}

// Review of PR #707, P3: both refusals were a bare 403, so the dialog told
// someone with an unverified email to check their password.
describe('link start refusals', () => {
  it('names an unverified email apart from a wrong password', async () => {
    expect(await startLink(false)).toEqual({
      status: 403,
      code: 'auth.email_not_verified',
    });
  });

  it('keeps a wrong current password a plain 403', async () => {
    expect(await startLink(true)).toEqual({
      status: 403,
      code: 'auth.forbidden',
    });
  });
});
