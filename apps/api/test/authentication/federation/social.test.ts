import { Pool } from 'pg';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { SocialSignInCommands } from '@pertexo/core/tenant-access';
import { SocialSignIn } from '../../../src/authentication/federation/social.js';
import type { SocialProviderGateway } from '../../../src/authentication/providers/contract.js';

const pool = new Pool({
  connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused',
});
afterAll(() => pool.end());
afterEach(() => vi.restoreAllMocks());

function signIn(secureCookies = false) {
  const providers: SocialProviderGateway = {
    available: ['google'],
    authorize: () => Promise.resolve('https://provider.example/authorize'),
    verify: () => Promise.resolve(undefined),
  };
  return new SocialSignIn({
    pool,
    signUpMode: 'open',
    secret: 'social-unit-secret-with-more-than-32-characters',
    baseUrl: 'https://app.example',
    secureCookies,
    sessionTtlSeconds: 3600,
    providers,
    deliver: () => Promise.resolve([]),
  });
}

describe('social sign-in HTTP boundary', () => {
  it.each([false, true])(
    'uses a short HttpOnly browser binding, secure=%s',
    async (secure) => {
      vi.spyOn(SocialSignInCommands.prototype, 'start').mockResolvedValue(
        undefined,
      );
      const response = await signIn(secure).handle(
        new Request('https://app.example/v1/auth/sign-in/social', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'google' }),
        }),
      );
      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({
        url: 'https://provider.example/authorize',
        redirect: true,
      });
      expect(response?.headers.get('cache-control')).toBe('no-store');
      const cookie = response?.headers.get('set-cookie');
      expect(cookie).toMatch(
        secure ? /^__Host-pertexo_signin=/u : /^pertexo_signin=/u,
      );
      expect(cookie).toContain('; Path=/; HttpOnly; SameSite=Lax; Max-Age=300');
      expect(cookie?.includes('; Secure')).toBe(secure);
      expect(cookie).not.toContain('Domain=');
    },
  );

  it.each([
    { provider: 'unknown' },
    { provider: 'google', idToken: 'client-asserted-proof' },
    {},
  ])(
    'rejects malformed or client-asserted identities before storage: %j',
    async (body) => {
      const response = await signIn().handle(
        new Request('https://app.example/v1/auth/sign-in/social', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      expect(response?.status).toBe(400);
    },
  );

  it('refuses an unconfigured provider without a provider call', async () => {
    const response = await signIn().handle(
      new Request('https://app.example/v1/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'github' }),
      }),
    );
    expect(response?.status).toBe(404);
  });

  it('does not turn an untrusted error callback into a redirect target', async () => {
    const response = await signIn().handle(
      new Request(
        'https://app.example/v1/auth/federation/social/callback/google?error=provider-message&state=bad&code=bad',
      ),
    );
    expect(response?.headers.get('location')).toBe(
      'https://app.example/login?socialError=true',
    );
    expect(response?.headers.get('location')).not.toContain('provider-message');
    expect(response?.headers.get('cache-control')).toBe('no-store');
  });
});
