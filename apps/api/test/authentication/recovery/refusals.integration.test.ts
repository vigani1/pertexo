import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { betterAuthIntegrationEnabled } from '../../support/better-auth/real-api.support.js';
import {
  useRecoveryApi,
  replacementPassword,
} from './account-recovery.fixture.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'actionable account security refusals through Fastify',
  () => {
    const api = useRecoveryApi();
    it.each([
      {
        path: '/account-security/password/change',
        payload: {
          currentPassword: 'private-wrong-password',
          newPassword: replacementPassword,
        },
        status: 400,
        code: 'auth.invalid_password',
        title: 'The current password is incorrect. Check it and try again.',
      },
      {
        path: '/two-factor/enable',
        payload: { password: 'private-wrong-password' },
        status: 400,
        code: 'auth.invalid_password',
        title: 'The current password is incorrect. Check it and try again.',
      },
      {
        path: '/account-security/password/setup',
        payload: { newPassword: replacementPassword },
        status: 409,
        code: 'auth.password_already_configured',
        title:
          'A password is already configured. Reload security settings and use Change password.',
      },
      {
        path: '/account-security/methods/unlink',
        payload: { methodId: randomUUID() },
        status: 404,
        code: 'resource.not_found',
        title:
          'This sign-in method is no longer available. Reload security settings.',
      },
    ])(
      '$path keeps its specific safe refusal and security state',
      async ({ path, payload, status, code, title }) => {
        const person = await api.account();
        const before = await api.state(person.userId);
        const reply = await api.send('POST', `/v1/auth${path}`, {
          browser: person.browser,
          payload,
        });
        expect(reply.statusCode, reply.payload).toBe(status);
        expect(reply.json()).toMatchObject({ code, title, status });
        expect(reply.payload).not.toContain('private-wrong-password');
        expect(reply.headers['set-cookie']).toBeUndefined();
        expect(await api.state(person.userId)).toEqual(before);
      },
    );
    it('tells a stale sensitive session to sign in again without changing the account', async () => {
      const person = await api.account();
      await api
        .database()
        .query(
          "update app.auth_sessions set created_at=clock_timestamp()-interval '10 minutes' where user_id=$1",
          [person.userId],
        );
      const before = await api.state(person.userId);
      const reply = await api.send(
        'POST',
        '/v1/auth/account-security/password/setup',
        {
          browser: person.browser,
          payload: { newPassword: replacementPassword },
        },
      );
      expect(reply.statusCode, reply.payload).toBe(403);
      expect(reply.json()).toMatchObject({
        code: 'auth.session_not_fresh',
        title: 'Sign in again before changing account security settings.',
      });
      expect(await api.state(person.userId)).toEqual(before);
    });
    it('instructs the person to sign out when revoking the current session', async () => {
      const person = await api.account();
      const listing = await api.send(
        'GET',
        '/v1/auth/account-security/sessions',
        { browser: person.browser },
      );
      const sessionId = listing
        .json<{ items: { id: string; current: boolean }[] }>()
        .items.find((session) => session.current)?.id;
      const before = await api.state(person.userId);
      const reply = await api.send(
        'POST',
        '/v1/auth/account-security/sessions/revoke',
        { browser: person.browser, payload: { sessionId } },
      );
      expect(reply.statusCode, reply.payload).toBe(400);
      expect(reply.json()).toMatchObject({
        code: 'request.invalid',
        title: 'Sign out to end the current session.',
      });
      expect(await api.state(person.userId)).toEqual(before);
    });
    it('keeps anonymous wrong-password sign-in generic and secret-free', async () => {
      const person = await api.account();
      const reply = await api.signInWith(
        person.email,
        'anonymous-private-password',
      );
      expect(reply.statusCode).toBe(401);
      expect(reply.json()).toMatchObject({
        code: 'auth.invalid_credentials',
        title: 'Sign-in details not accepted',
      });
      expect(reply.payload).not.toContain(person.email);
      expect(reply.payload).not.toContain('anonymous-private-password');
    });

    it('requires email verification before a server-issued session can configure a password', async () => {
      const email = `unverified-${randomUUID()}@example.test`;
      const signup = await api.send('POST', '/v1/auth/sign-up/email', {
        payload: {
          name: 'Unverified Person',
          email,
          password: 'a long enough integration password',
        },
      });
      expect(signup.statusCode, signup.payload).toBe(200);
      const {
        rows: [user],
      } = await api
        .database()
        .query<{ id: string }>('select id from app.users where email=$1', [
          email,
        ]);
      if (user === undefined) throw new Error('Unverified fixture missing');
      const issued = await api.identity().betterAuth.sessions.issue(user.id);
      const csrf = 'unverified-csrf-with-more-than-thirty-two-characters';
      const reply = await api.send(
        'POST',
        '/v1/auth/account-security/password/setup',
        {
          headers: {
            cookie:
              issued.setCookies.map((value) => value.split(';')[0]).join('; ') +
              `; pertexo_csrf=${csrf}`,
            'x-csrf-token': csrf,
          },
          payload: { newPassword: replacementPassword },
        },
      );
      expect(reply.statusCode, reply.payload).toBe(403);
      expect(reply.json()).toMatchObject({
        code: 'auth.email_not_verified',
        title: 'Verify your email before adding a password.',
      });
      expect(
        (
          await api
            .database()
            .query('select email_verified from app.users where id=$1', [
              user.id,
            ])
        ).rows,
      ).toEqual([{ email_verified: false }]);
    });
  },
);
