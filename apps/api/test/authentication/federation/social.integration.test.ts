import { describe, expect, it, vi } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  browserFrom,
  expectProblem,
  origin,
} from '../../support/better-auth/real-api.support.js';
import {
  createSocialSignInFixture,
  verifications,
  gateway,
} from './social/fixture.js';
import { createHash, randomUUID } from 'node:crypto';

describe.skipIf(!betterAuthIntegrationEnabled)(
  'browser-bound social sign-in on the real API',
  () => {
    const caseFixture = createSocialSignInFixture();

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
      expect(JSON.stringify(stored)).not.toContain(
        journey.cookie.split('=')[1],
      );
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
        (await api.send('GET', '/v1/users/me', { browser: current }))
          .statusCode,
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

    const {
      identity: identity2,
      finish: finish2,
      start: start2,
      api: api2,
      userId: userId2,
      providerFixture,
    } = caseFixture;

    it.each(['suspended', 'deleted'])(
      'refuses a %s user after a valid provider proof',
      async (status) => {
        const proof = identity2();
        const first = await finish2(await start2(proof));
        const old = browserFrom(first);
        await api2
          .database()
          .query('update app.users set status=$2 where id=$1', [
            await userId2(proof.email ?? ''),
            status,
          ]);
        expect((await finish2(await start2(proof))).headers.location).toContain(
          '/login?socialError=true',
        );
        expect(
          (await api2.send('GET', '/v1/users/me', { browser: old })).statusCode,
        ).toBe(401);
      },
    );

    it.each(['https://other.example/path', '//other.example/path'])(
      'keeps an untrusted return target on the app origin: %s',
      async (callbackURL) => {
        expect(
          (await finish2(await start2(identity2(), 'google', callbackURL)))
            .headers.location,
        ).toBe(`${origin}/workspaces`);
      },
    );

    it('refuses unverified provider or local email without attaching a method', async () => {
      const external = { ...identity2(), emailVerified: false };
      expect(
        (await finish2(await start2(external))).headers.location,
      ).toContain('/login?socialError=true');
      const local = identity2();
      const signup = await api2.send('POST', '/v1/auth/sign-up/email', {
        payload: {
          email: local.email,
          name: 'Unverified',
          password: 'a long enough integration password',
        },
      });
      expect(signup.statusCode).toBe(200);
      expect((await finish2(await start2(local))).headers.location).toContain(
        '/login?socialError=true',
      );
      expect(
        (
          await api2
            .database()
            .query(
              "select count(*)::int n from app.auth_accounts where user_id=$1 and provider_id='google'",
              [await userId2(local.email ?? '')],
            )
        ).rows[0],
      ).toEqual({ n: 0 });
    });

    it('rejects wrong or absent browser binding before calling the provider', async () => {
      const journey = await start2(identity2());
      const before = verifications;
      expect((await finish2(journey, '')).headers.location).toContain(
        '/login?socialError=true',
      );
      expect(
        (await finish2(journey, `pertexo_signin=${'a'.repeat(43)}`)).headers
          .location,
      ).toContain('/login?socialError=true');
      expect(verifications).toBe(before);
      const duplicate = {
        ...journey,
        callback: `${journey.callback}&state=${journey.state}`,
      };
      expect((await finish2(duplicate)).headers.location).toContain(
        '/login?socialError=true',
      );
      expect(verifications).toBe(before);
      expect((await finish2(journey)).headers.location).toBe(
        `${origin}/workspaces`,
      );
    });

    it('keeps ordinary requests responsive while provider verification is blocked', async () => {
      const email = `available-${randomUUID()}@example.test`;
      await api2.signUp(email, '/workspaces');
      const browser = await api2.signIn(email);
      const journey = await start2(identity2());
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
      const callback = Promise.resolve(finish2(journey));
      try {
        await entered.promise;
        const address = await api2.listen();
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
      const expired = await start2(identity2());
      await api2
        .database()
        .query(
          "update app.auth_sign_in_attempts set created_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute' where state_digest=$1",
          [createHash('sha256').update(expired.state).digest()],
        );
      expect((await finish2(expired)).headers.location).toContain(
        '/login?socialError=true',
      );
      const proof = identity2();
      const race = await start2(proof);
      const peer = providerFixture.createPeer();
      let locations: (string | undefined | null)[];
      try {
        const replies = await Promise.all([
          finish2(race),
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
      expect((await finish2(race)).headers.location).toContain(
        '/login?socialError=true',
      );
      const id = await userId2(proof.email ?? '');
      expect(
        (
          await api2
            .database()
            .query(
              'select count(*)::int n from app.auth_sessions where user_id=$1',
              [id],
            )
        ).rows[0],
      ).toEqual({ n: 1 });
    });

    const {
      identity: identity3,
      api: api3,
      userId: userId3,
      start: start3,
      finish: finish3,
    } = caseFixture;

    it('rolls back linking, audit and revocation when final consumption fails', async () => {
      const proof = identity3();
      const email = proof.email ?? '';
      await api3.signUp(email, '/workspaces');
      const old = await api3.signIn(email);
      const id = await userId3(email);
      const journey = await start3(proof);
      await api3
        .database()
        .query(
          'alter table app.auth_sign_in_attempts add constraint fixture_consumption_fails check(consumed_at is null) not valid',
        );
      let response: Awaited<ReturnType<typeof finish3>>;
      try {
        response = await finish3(journey);
      } finally {
        await api3
          .database()
          .query(
            'alter table app.auth_sign_in_attempts drop constraint fixture_consumption_fails',
          );
      }
      expect(response.headers.location).toContain('/login?socialError=true');
      expect(
        (await api3.send('GET', '/v1/users/me', { browser: old })).statusCode,
      ).toBe(200);
      expect(
        (
          await api3
            .database()
            .query(
              "select count(*)::int n from app.auth_accounts where user_id=$1 and provider_id='google'",
              [id],
            )
        ).rows[0],
      ).toEqual({ n: 0 });
      expect(
        (
          await api3
            .database()
            .query(
              "select count(*)::int n from app.identity_security_audit_facts where user_id=$1 and event_type in ('method.linked','session.signed_in')",
              [id],
            )
        ).rows[0],
      ).toEqual({ n: 0 });
      expect(
        (
          await api3
            .database()
            .query(
              'select consumed_at from app.auth_sign_in_attempts where state_digest=$1',
              [createHash('sha256').update(journey.state).digest()],
            )
        ).rows[0],
      ).toEqual({ consumed_at: null });
    });
  },
);
