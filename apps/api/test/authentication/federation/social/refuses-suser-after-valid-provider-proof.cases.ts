import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';

import {
  browserFrom,
  origin,
} from '../../../support/better-auth/real-api.support.js';
import type { createSocialSignInFixture } from './fixture.js';
import { verifications, gateway } from './fixture.js';

export function registerRefusesSUserAfterValidProviderProof(
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
