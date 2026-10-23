import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  SocialProviderGateway,
  VerifiedSocialIdentity,
} from '../../../src/authentication/providers/contract.js';
import { useSocialProviderGateway } from '../../support/better-auth/social-provider.js';
import {
  betterAuthIntegrationEnabled,
  browserFrom,
  expectProblem,
  origin,
  setCookie,
  useBetterAuthRealApi,
} from '../../support/better-auth/real-api.support.js';

const authorizations = new Map<
  string,
  Parameters<SocialProviderGateway['authorize']>[0]
>();
const proofs = new Map<string, VerifiedSocialIdentity>();
let verifications = 0;
const gateway: SocialProviderGateway = {
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

describe.skipIf(!betterAuthIntegrationEnabled)(
  'browser-bound social sign-in on the real API',
  () => {
    const caseFixture = createSocialSignInFixture();

    registerLandsAppleCrossSiteFormVerifiesIt(caseFixture);

    registerRefusesSUserAfterValidProviderProof(caseFixture);

    registerRollsBackLinkingAuditRevocationFinalConsumption(caseFixture);
  },
);

function registerLandsAppleCrossSiteFormVerifiesIt(
  caseFixture: ReturnType<typeof createSocialSignInFixture>,
): void {
  const { start, identity, api, finish, userId } = caseFixture;

  it('lands an Apple cross-site form and verifies it only with the browser binding on GET', async () => {
    const journey = await start(identity(), 'apple');
    const callback = new URL(journey.callback, origin);
    const landed = await api.send('POST', callback.pathname, {
      headers: {
        origin: 'https://appleid.apple.com',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: callback.searchParams.toString(),
    });
    expect(landed.statusCode, landed.payload).toBe(303);
    expect(landed.headers['set-cookie']).toBeUndefined();
    expect(landed.headers['referrer-policy']).toBe('no-referrer');
    const path =
      new URL(String(landed.headers.location)).pathname +
      new URL(String(landed.headers.location)).search;
    expect((await api.send('GET', path)).headers.location).toContain(
      'socialError=true',
    );
    const completed = await api.send('GET', path, {
      headers: { cookie: journey.cookie },
    });
    expect(completed.statusCode).toBe(302);
    expect(completed.headers.location).toBe(`${origin}/workspaces`);
    expect(completed.headers['set-cookie']).toBeDefined();
  });

  it('serializes first sign-ins from different providers for the same verified email', async () => {
    const email = `concurrent-${randomUUID()}@example.test`;
    const google = await start(identity(email), 'google');
    const github = await start(identity(email), 'github');
    const replies = await Promise.all([finish(google), finish(github)]);
    expect(replies.map((reply) => reply.statusCode)).toEqual([302, 302]);
    const id = await userId(email);
    const accounts = await api
      .database()
      .query<{ provider_id: string }>(
        'select provider_id from app.auth_accounts where user_id=$1 order by provider_id',
        [id],
      );
    expect(accounts.rows).toEqual([
      { provider_id: 'github' },
      { provider_id: 'google' },
    ]);
    const sessions = await api
      .database()
      .query<{ count: number }>(
        'select count(*)::int count from app.auth_sessions where user_id=$1',
        [id],
      );
    expect(sessions.rows[0]?.count).toBe(1);
  });

  it('advertises only configured providers and closes the native callback', async () => {
    const capabilities = await api.send('GET', '/v1/auth/capabilities');
    expect(capabilities.json()).toMatchObject({
      socialProviders: ['google', 'github', 'apple'],
    });
    expectProblem(
      await api.send('POST', '/v1/auth/sign-in/social', {
        payload: { provider: 'microsoft' },
      }),
      404,
      'resource.not_found',
    );
    const native = await api.send(
      'GET',
      '/v1/auth/callback/google?state=forged&code=forged',
    );
    expect(native.statusCode).toBe(404);
  });

  it('creates one verified user and delivers a signed Better Auth session without storing proof tokens', async () => {
    const proof = identity();
    const journey = await start(proof);
    const response = await finish(journey);
    expect(response.statusCode).toBe(302);
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.location).toBe(`${origin}/workspaces`);
    const browser = browserFrom(response);
    const me = await api.send('GET', '/v1/users/me', { browser });
    expect(me.statusCode, me.payload).toBe(200);
    const id = await userId(proof.email ?? '');
    expect(
      (
        await api
          .database()
          .query(
            'select email_verified,display_name from app.users where id=$1',
            [id],
          )
      ).rows[0],
    ).toMatchObject({ email_verified: true, display_name: 'Social Person' });
    const stored = (
      await api.database().query<{
        consumed_at: Date | null;
        state_digest: Buffer;
        browser_digest: Buffer;
      }>('select * from app.auth_sign_in_attempts where state_digest=$1', [createHash('sha256').update(journey.state).digest()])
    ).rows[0];
    expect(stored?.consumed_at).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(journey.state);
    expect(JSON.stringify(stored)).not.toContain(journey.cookie.split('=')[1]);
    expect(
      (
        await api
          .database()
          .query(
            'select event_type from app.identity_security_audit_facts where user_id=$1 order by event_type',
            [id],
          )
      ).rows,
    ).toEqual([
      { event_type: 'method.linked' },
      { event_type: 'session.signed_in' },
    ]);
    expect(
      (
        await api
          .database()
          .query(
            'select access_token,refresh_token,id_token from app.auth_accounts where user_id=$1',
            [id],
          )
      ).rows[0],
    ).toEqual({ access_token: null, refresh_token: null, id_token: null });
  });

  it('links only a verified matching local account and revokes its previous sessions', async () => {
    const proof = identity();
    const email = proof.email ?? '';
    await api.signUp(email, '/workspaces');
    const old = await api.signIn(email);
    const id = await userId(email);
    const journey = await start(proof, 'github', '/account/security');
    const response = await finish(journey);
    expect(response.headers.location).toBe(`${origin}/account/security`);
    const current = browserFrom(response);
    expect(
      (await api.send('GET', '/v1/users/me', { browser: old })).statusCode,
    ).toBe(401);
    expect(
      (await api.send('GET', '/v1/users/me', { browser: current })).statusCode,
    ).toBe(200);
    expect(await userId(email)).toBe(id);
    expect(
      (
        await api
          .database()
          .query('select display_name from app.users where id=$1', [id])
      ).rows[0],
    ).toEqual({ display_name: 'New Person' });
  });

  it('keeps an already-bound subject on its original user when the provider email changes', async () => {
    const proof = identity();
    const first = await finish(await start(proof));
    const old = browserFrom(first);
    const id = await userId(proof.email ?? '');
    const response = await finish(
      await start({
        ...proof,
        email: `changed-${randomUUID()}@example.test`,
      }),
    );
    expect(
      (
        await api.send('GET', '/v1/users/me', {
          browser: browserFrom(response),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await api.send('GET', '/v1/users/me', { browser: old })).statusCode,
    ).toBe(200);
    expect(
      (
        await api
          .database()
          .query('select email from app.users where id=$1', [id])
      ).rows[0],
    ).toEqual({ email: proof.email });
    expect(
      (
        await api
          .database()
          .query(
            "select count(*)::int n from app.identity_security_audit_facts where user_id=$1 and event_type='method.linked'",
            [id],
          )
      ).rows[0],
    ).toEqual({ n: 1 });
  });
}

function registerRefusesSUserAfterValidProviderProof(
  caseFixture: ReturnType<typeof createSocialSignInFixture>,
): void {
  const { identity, finish, start, api, userId, providerFixture } = caseFixture;

  it.each(['suspended', 'deleted'])(
    'refuses a %s user after a valid provider proof',
    async (status) => {
      const proof = identity();
      const first = await finish(await start(proof));
      const old = browserFrom(first);
      await api
        .database()
        .query('update app.users set status=$2 where id=$1', [
          await userId(proof.email ?? ''),
          status,
        ]);
      expect((await finish(await start(proof))).headers.location).toContain(
        '/login?socialError=true',
      );
      expect(
        (await api.send('GET', '/v1/users/me', { browser: old })).statusCode,
      ).toBe(401);
    },
  );

  it.each(['https://other.example/path', '//other.example/path'])(
    'keeps an untrusted return target on the app origin: %s',
    async (callbackURL) => {
      expect(
        (await finish(await start(identity(), 'google', callbackURL))).headers
          .location,
      ).toBe(`${origin}/workspaces`);
    },
  );

  it('refuses unverified provider or local email without attaching a method', async () => {
    const external = { ...identity(), emailVerified: false };
    expect((await finish(await start(external))).headers.location).toContain(
      '/login?socialError=true',
    );
    const local = identity();
    const signup = await api.send('POST', '/v1/auth/sign-up/email', {
      payload: {
        email: local.email,
        name: 'Unverified',
        password: 'a long enough integration password',
      },
    });
    expect(signup.statusCode).toBe(200);
    expect((await finish(await start(local))).headers.location).toContain(
      '/login?socialError=true',
    );
    expect(
      (
        await api
          .database()
          .query(
            "select count(*)::int n from app.auth_accounts where user_id=$1 and provider_id='google'",
            [await userId(local.email ?? '')],
          )
      ).rows[0],
    ).toEqual({ n: 0 });
  });

  it('rejects wrong or absent browser binding before calling the provider', async () => {
    const journey = await start(identity());
    const before = verifications;
    expect((await finish(journey, '')).headers.location).toContain(
      '/login?socialError=true',
    );
    expect(
      (await finish(journey, `pertexo_signin=${'a'.repeat(43)}`)).headers
        .location,
    ).toContain('/login?socialError=true');
    expect(verifications).toBe(before);
    const duplicate = {
      ...journey,
      callback: `${journey.callback}&state=${journey.state}`,
    };
    expect((await finish(duplicate)).headers.location).toContain(
      '/login?socialError=true',
    );
    expect(verifications).toBe(before);
    expect((await finish(journey)).headers.location).toBe(
      `${origin}/workspaces`,
    );
  });

  it('keeps ordinary requests responsive while provider verification is blocked', async () => {
    const email = `available-${randomUUID()}@example.test`;
    await api.signUp(email, '/workspaces');
    const browser = await api.signIn(email);
    const journey = await start(identity());
    const entered = Promise.withResolvers<undefined>();
    const released = Promise.withResolvers<undefined>();
    const original = gateway.verify;
    const verifying = vi
      .spyOn(gateway, 'verify')
      .mockImplementation(async (input) => {
        if (input.code === journey.state) {
          entered.resolve(undefined);
          await released.promise;
        }
        return original(input);
      });
    const callback = Promise.resolve(finish(journey));
    try {
      await entered.promise;
      const address = await api.listen();
      const response = await fetch(`${address}/v1/users/me`, {
        headers: { cookie: browser.cookie },
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    } finally {
      released.resolve(undefined);
      await callback;
      verifying.mockRestore();
    }
  });

  it('fences expired, replayed and racing callbacks without wall-clock sleeps', async () => {
    const expired = await start(identity());
    await api
      .database()
      .query(
        "update app.auth_sign_in_attempts set created_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute' where state_digest=$1",
        [createHash('sha256').update(expired.state).digest()],
      );
    expect((await finish(expired)).headers.location).toContain(
      '/login?socialError=true',
    );
    const proof = identity();
    const race = await start(proof);
    const peer = providerFixture.createPeer();
    let locations: (string | undefined | null)[];
    try {
      const replies = await Promise.all([
        finish(race),
        peer.auth.handler(
          new Request(origin + race.callback, {
            headers: { cookie: race.cookie },
          }),
        ),
      ]);
      locations = [
        replies[0].headers.location,
        replies[1].headers.get('location'),
      ];
    } finally {
      await peer.close();
    }
    expect(
      locations.filter((location) => location === `${origin}/workspaces`),
    ).toHaveLength(1);
    expect((await finish(race)).headers.location).toContain(
      '/login?socialError=true',
    );
    const id = await userId(proof.email ?? '');
    expect(
      (
        await api
          .database()
          .query(
            'select count(*)::int n from app.auth_sessions where user_id=$1',
            [id],
          )
      ).rows[0],
    ).toEqual({ n: 1 });
  });
}

function registerRollsBackLinkingAuditRevocationFinalConsumption(
  caseFixture: ReturnType<typeof createSocialSignInFixture>,
): void {
  const { identity, api, userId, start, finish } = caseFixture;

  it('rolls back linking, audit and revocation when final consumption fails', async () => {
    const proof = identity();
    const email = proof.email ?? '';
    await api.signUp(email, '/workspaces');
    const old = await api.signIn(email);
    const id = await userId(email);
    const journey = await start(proof);
    await api
      .database()
      .query(
        'alter table app.auth_sign_in_attempts add constraint fixture_consumption_fails check(consumed_at is null) not valid',
      );
    let response: Awaited<ReturnType<typeof finish>>;
    try {
      response = await finish(journey);
    } finally {
      await api
        .database()
        .query(
          'alter table app.auth_sign_in_attempts drop constraint fixture_consumption_fails',
        );
    }
    expect(response.headers.location).toContain('/login?socialError=true');
    expect(
      (await api.send('GET', '/v1/users/me', { browser: old })).statusCode,
    ).toBe(200);
    expect(
      (
        await api
          .database()
          .query(
            "select count(*)::int n from app.auth_accounts where user_id=$1 and provider_id='google'",
            [id],
          )
      ).rows[0],
    ).toEqual({ n: 0 });
    expect(
      (
        await api
          .database()
          .query(
            "select count(*)::int n from app.identity_security_audit_facts where user_id=$1 and event_type in ('method.linked','session.signed_in')",
            [id],
          )
      ).rows[0],
    ).toEqual({ n: 0 });
    expect(
      (
        await api
          .database()
          .query(
            'select consumed_at from app.auth_sign_in_attempts where state_digest=$1',
            [createHash('sha256').update(journey.state).digest()],
          )
      ).rows[0],
    ).toEqual({ consumed_at: null });
  });
}

function createSocialSignInFixture() {
  const providerFixture = useSocialProviderGateway(gateway);

  const api = useBetterAuthRealApi('social', {
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
