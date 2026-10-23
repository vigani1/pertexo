import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  browserFrom,
  expectProblem,
  origin,
} from '../../../support/better-auth/real-api.support.js';
import type { createSocialSignInFixture } from './fixture.js';

export function registerLandsAppleCrossSiteFormVerifiesIt(
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
