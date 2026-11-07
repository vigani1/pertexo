import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  browserFrom,
} from '../../support/better-auth/real-api.support.js';
import { createSocialSignInFixture } from './social-sign-in.fixture.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'a configured social alternative remains usable after removal',
  () => {
    const { api, identity, start, finish } = createSocialSignInFixture();
    it('removes the password only while the permitted configured provider can still sign in', async () => {
      const email = `usable-social-${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      const browser = await api.signIn(email),
        proof = identity(email);
      await api
        .database()
        .query(
          "insert into app.auth_accounts(id,user_id,provider_id,account_id) select $1,id,'google',$2 from app.users where email=$3",
          [randomUUID(), proof.accountId, email],
        );
      const security = await api.send('GET', '/v1/auth/account-security', {
        browser,
      });
      const password = security
        .json<{ methods: { kind: string; id: string }[] }>()
        .methods.find((method) => method.kind === 'password');
      if (password === undefined) throw new Error('Password method missing');
      const removed = await api.send(
        'POST',
        '/v1/auth/account-security/methods/unlink',
        { browser, payload: { methodId: password.id } },
      );
      expect(removed.statusCode, removed.payload).toBe(200);
      expect(
        (await api.send('GET', '/v1/users/me', { browser })).statusCode,
      ).toBe(401);
      expect(
        (
          await api.send('GET', '/v1/users/me', {
            browser: browserFrom(removed),
          })
        ).statusCode,
      ).toBe(200);
      const social = await finish(await start(proof));
      expect(social.headers.location).toBe(
        'https://app.integration.test/workspaces',
      );
      expect(
        (
          await api.send('GET', '/v1/users/me', {
            browser: browserFrom(social),
          })
        ).statusCode,
      ).toBe(200);
      const methods = await api.send('GET', '/v1/auth/account-security', {
        browser: browserFrom(social),
      });
      expect(methods.json()).toMatchObject({
        methods: [{ kind: 'social', provider: 'google' }],
      });
    });
  },
);
