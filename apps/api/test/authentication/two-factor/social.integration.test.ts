import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SocialProviderGateway } from '../../../src/authentication/providers/contract.js';
import {
  betterAuthIntegrationEnabled,
  browserFrom,
  origin,
  setCookie,
  useBetterAuthRealApi,
} from '../../support/better-auth/real-api.support.js';
import { useSocialProviderGateway } from '../../support/better-auth/social-provider.js';
import { enrollFactor } from '../../support/better-auth/two-factor.js';

describe.skipIf(!betterAuthIntegrationEnabled)(
  'social sign-in with a local second factor',
  () => {
    const email = `factor-${randomUUID()}@example.test`;
    const proofs = new Map<
      string,
      Parameters<SocialProviderGateway['authorize']>[0]
    >();
    useSocialProviderGateway({
      available: ['google'],
      authorize: (proof) => {
        proofs.set(proof.state, proof);
        return Promise.resolve(
          `https://provider.integration.test/authorize?state=${proof.state}`,
        );
      },
      verify: (input) => {
        const proof = proofs.get(input.code);
        return Promise.resolve(
          proof?.codeVerifier === input.codeVerifier &&
            proof.nonce === input.nonce &&
            proof.redirectUri === input.redirectUri
            ? { accountId: randomUUID(), email, emailVerified: true }
            : undefined,
        );
      },
    });
    const api = useBetterAuthRealApi('2fa_social', {
      databasePoolMax: 1,
      socialProviders: {
        google: { clientId: 'fixture-client', clientSecret: 'fixture-secret' },
      },
    });
    it('lets the provider own its second factor while password sign-in still requires the local factor', async () => {
      await api.signUp(email, '/workspaces');
      await enrollFactor(api, await api.signIn(email));
      const started = await api.send('POST', '/v1/auth/sign-in/social', {
        payload: { provider: 'google', callbackURL: '/workspaces' },
      });
      expect(started.statusCode).toBe(200);
      const state = new URL(
        started.json<{ url: string }>().url,
      ).searchParams.get('state');
      if (state === null) throw new Error('Provider state missing');
      const proof = proofs.get(state);
      if (proof === undefined) throw new Error('Provider proof missing');
      const callback = new URL(proof.redirectUri);
      callback.searchParams.set('state', state);
      callback.searchParams.set('code', state);
      const reply = await api.send('GET', callback.pathname + callback.search, {
        headers: {
          cookie: `pertexo_signin=${setCookie(started, 'pertexo_signin')}`,
        },
      });
      expect(reply.statusCode).toBe(302);
      expect(reply.headers.location).toBe(`${origin}/workspaces`);
      const browser = browserFrom(reply);
      expect(
        (await api.send('GET', '/v1/users/me', { browser })).statusCode,
      ).toBe(200);
      const security = await api.send('GET', '/v1/auth/account-security', {
        browser,
      });
      expect(security.json()).toMatchObject({
        twoFactor: { enabled: true, recoveryCodesRemaining: 10 },
      });
    });
  },
);
