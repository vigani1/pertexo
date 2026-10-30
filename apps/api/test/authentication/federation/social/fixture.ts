import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type {
  SocialProviderGateway,
  VerifiedSocialIdentity,
} from '../../../../src/authentication/providers/contract.js';
import { useSocialProviderGateway } from '../../../support/better-auth/social-provider.js';
import {
  setCookie,
  useBetterAuthRealApi,
} from '../../../support/better-auth/real-api.support.js';

type ApiFixtureOptions = NonNullable<
  Parameters<typeof useBetterAuthRealApi>[1]
>;

const authorizations = new Map<
  string,
  Parameters<SocialProviderGateway['authorize']>[0]
>();

const proofs = new Map<string, VerifiedSocialIdentity>();

export let verifications = 0;

export const gateway: SocialProviderGateway = {
  available: ['google', 'github', 'apple'],
  authorize: (input) => {
    authorizations.set(input.state, input);
    return Promise.resolve(
      `https://provider.integration.test/authorize?state=${input.state}`,
    );
  },
  verify: (input) => {
    verifications += 1;
    const expected = authorizations.get(input.code);
    return Promise.resolve(
      expected?.provider === input.provider &&
        expected.codeVerifier === input.codeVerifier &&
        expected.nonce === input.nonce &&
        expected.redirectUri === input.redirectUri &&
        input.issuer === null
        ? proofs.get(input.code)
        : undefined,
    );
  },
};

export function createSocialSignInFixture(
  options: Pick<ApiFixtureOptions, 'signUpMode'> = {},
) {
  const providerFixture = useSocialProviderGateway(gateway);

  const api = useBetterAuthRealApi('social', {
    ...options,
    databasePoolMax: 1,
    socialProviders: {
      google: { clientId: 'fixture-client', clientSecret: 'fixture-secret' },
      github: { clientId: 'fixture-client', clientSecret: 'fixture-secret' },
      apple: { clientId: 'fixture-client', clientSecret: 'fixture-secret' },
    },
  });

  function identity(
    email = `social-${randomUUID()}@example.test`,
  ): VerifiedSocialIdentity {
    return {
      accountId: randomUUID(),
      email,
      emailVerified: true,
      displayName: 'Social Person',
    };
  }

  async function start(
    proof: VerifiedSocialIdentity,
    provider = 'google',
    callbackURL = '/workspaces',
  ) {
    const response = await api.send('POST', '/v1/auth/sign-in/social', {
      payload: { provider, callbackURL },
    });
    expect(response.statusCode, response.payload).toBe(200);
    const value: unknown = response.json();
    if (
      typeof value !== 'object' ||
      value === null ||
      !('url' in value) ||
      typeof value.url !== 'string'
    )
      throw new Error('Authorization URL is missing');
    const state = new URL(value.url).searchParams.get('state');
    if (state === null) throw new Error('Authorization state is missing');
    proofs.set(state, proof);
    const expected = authorizations.get(state);
    if (expected === undefined)
      throw new Error('Authorization proof is missing');
    const callback = new URL(expected.redirectUri);
    callback.searchParams.set('state', state);
    callback.searchParams.set('code', state);
    return {
      state,
      callback: callback.pathname + callback.search,
      cookie: `pertexo_signin=${setCookie(response, 'pertexo_signin')}`,
    };
  }

  const finish = (
    journey: Awaited<ReturnType<typeof start>>,
    cookie = journey.cookie,
  ) => api.send('GET', journey.callback, { headers: { cookie } });

  async function userId(email: string) {
    const row = (
      await api
        .database()
        .query<{ id: string }>(
          'select id from app.users where lower(email)=lower($1)',
          [email],
        )
    ).rows[0];
    if (row === undefined) throw new Error('Expected user');
    return row.id;
  }
  return { start, identity, api, finish, userId, providerFixture };
}
