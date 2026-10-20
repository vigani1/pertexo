import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accountSecurityResponseSchema } from '@pertexo/contracts';
import {
  betterAuthIntegrationEnabled,
  browserFrom,
  expectProblem,
} from '../../support/better-auth/real-api.support.js';
import {
  authenticatorCode,
  enrollFactor,
  challengeCookie,
  factorPassword,
} from '../../support/better-auth/two-factor.js';
import { useOrganizationApi } from '../federation/organization/fixture.js';

function useFactorApi(suite: string) {
  const api = useOrganizationApi(suite);
  async function person() {
    const email = `${randomUUID()}@example.test`;
    await api.signUp(email, '/workspaces');
    const original = await api.signIn(email);
    return { email, original, ...(await enrollFactor(api, original)) };
  }
  async function challenge(email: string, password = factorPassword) {
    const reply = await api.send('POST', '/v1/auth/sign-in/email', {
      payload: { email, password },
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({
      twoFactorRedirect: true,
      twoFactorMethods: ['totp'],
    });
    return challengeCookie(reply);
  }
  const verify = (cookie: string, code: string, backup = false) =>
    api.send(
      'POST',
      `/v1/auth/two-factor/${backup ? 'verify-backup-code' : 'verify-totp'}`,
      { headers: { cookie }, payload: { code } },
    );
  return { api, person, challenge, verify };
}

describe.skipIf(!betterAuthIntegrationEnabled)(
  'two-factor codes on the real API',
  () => {
    const { api, person, challenge, verify } = useFactorApi('2fa_codes');
    it('requires a code, refuses a wrong code, creates a fresh token-free session and consumes the challenge once', async () => {
      const user = await person();
      const cookie = await challenge(user.email);
      expectProblem(
        await api.send('GET', '/v1/users/me', { headers: { cookie } }),
        401,
        'auth.unauthenticated',
      );
      expectProblem(
        await verify(cookie, 'invalid'),
        401,
        'auth.unauthenticated',
      );
      const accepted = await verify(cookie, authenticatorCode(user.totpURI));
      expect(accepted.statusCode, accepted.payload).toBe(200);
      expect(accepted.json()).not.toHaveProperty('token');
      const browser = browserFrom(accepted);
      expect(
        (await api.send('GET', '/v1/users/me', { browser })).statusCode,
      ).toBe(200);
      const evidence = await api
        .identity()
        .betterAuth.sessions.evidence(browser.session);
      expect(evidence).toBeDefined();
      expect(Date.now() - (evidence?.signedInAt.getTime() ?? 0)).toBeLessThan(
        5 * 60_000,
      );
      expectProblem(
        await verify(cookie, authenticatorCode(user.totpURI)),
        401,
        'auth.unauthenticated',
      );
      const read = await api.send('GET', '/v1/auth/account-security', {
        browser,
      });
      expect(
        accountSecurityResponseSchema.parse(read.json()).twoFactor,
      ).toEqual({ enabled: true, recoveryCodesRemaining: 10 });
      expect(read.payload).not.toContain(user.backupCodes[0]);
      expect(read.payload).not.toContain(
        new URL(user.totpURI).searchParams.get('secret'),
      );
      const stored = await api.database().query<{
        secret: string;
        backup_codes: string;
        failed_verification_count: number;
        locked_until: Date | null;
      }>('select factor.secret,factor.backup_codes,factor.failed_verification_count,factor.locked_until from app.auth_two_factors factor join app.users users on users.id=factor.user_id where users.email=$1', [user.email]);
      expect(stored.rows[0]).toMatchObject({
        failed_verification_count: 0,
        locked_until: null,
      });
      expect(stored.rows[0]?.backup_codes).not.toContain(user.backupCodes[0]);
      expect(stored.rows[0]?.secret).not.toContain(
        new URL(user.totpURI).searchParams.get('secret'),
      );
    });
  },
);

describe.skipIf(!betterAuthIntegrationEnabled)(
  'two-factor recovery on the real API',
  () => {
    const { api, person, challenge, verify } = useFactorApi('2fa_recovery');
    it('consumes a recovery code once, including concurrent API requests, and reports only the unused count', async () => {
      const user = await person();
      const code = user.backupCodes[0];
      if (code === undefined) throw new Error('Recovery code missing');
      const cookies = await Promise.all([
        challenge(user.email),
        challenge(user.email),
      ]);
      const replies = await Promise.all(
        cookies.map((cookie) => verify(cookie, code, true)),
      );
      expect(replies.filter((reply) => reply.statusCode === 200)).toHaveLength(
        1,
      );
      const accepted = replies.find((reply) => reply.statusCode === 200);
      if (accepted === undefined) throw new Error('Recovery sign-in missing');
      expect(accepted.json()).not.toHaveProperty('token');
      const browser = browserFrom(accepted);
      const read = await api.send('GET', '/v1/auth/account-security', {
        browser,
      });
      expect(read.json()).toMatchObject({
        twoFactor: { enabled: true, recoveryCodesRemaining: 9 },
      });
      expectProblem(
        await verify(await challenge(user.email), code, true),
        401,
        'auth.unauthenticated',
      );
    });
  },
);

describe.skipIf(!betterAuthIntegrationEnabled)(
  'two-factor management on the real API',
  () => {
    const { api, person, challenge, verify } = useFactorApi('2fa_manage');
    it('requires password, fresh session and CSRF to replace codes or disable, and keeps other sessions signed in', async () => {
      const user = await person();
      const other = browserFrom(
        await verify(
          await challenge(user.email),
          authenticatorCode(user.totpURI),
        ),
      );
      for (const path of ['disable', 'generate-backup-codes']) {
        expectProblem(
          await api.send('POST', `/v1/auth/two-factor/${path}`, {
            browser: user.browser,
            payload: { password: 'wrong-password' },
          }),
          400,
          'request.invalid',
        );
        expectProblem(
          await api.send('POST', `/v1/auth/two-factor/${path}`, {
            headers: { cookie: user.browser.cookie },
            payload: { password: factorPassword },
          }),
          403,
          'auth.forbidden',
        );
      }
      const generated = await api.send(
        'POST',
        '/v1/auth/two-factor/generate-backup-codes',
        { browser: user.browser, payload: { password: factorPassword } },
      );
      expect(generated.statusCode).toBe(200);
      const codes = generated.json<{ backupCodes: string[] }>().backupCodes;
      expect(codes).toHaveLength(10);
      expectProblem(
        await verify(
          await challenge(user.email),
          user.backupCodes[0] ?? '',
          true,
        ),
        401,
        'auth.unauthenticated',
      );
      expect(
        (await verify(await challenge(user.email), codes[0] ?? '', true))
          .statusCode,
      ).toBe(200);
      await api
        .database()
        .query(
          "update app.auth_sessions set created_at=clock_timestamp()-interval '6 minutes' where token=split_part($1,'.',1)",
          [decodeURIComponent(user.browser.session)],
        );
      for (const path of [
        'enable',
        'disable',
        'get-totp-uri',
        'generate-backup-codes',
      ])
        expectProblem(
          await api.send('POST', `/v1/auth/two-factor/${path}`, {
            browser: user.browser,
            payload: { password: factorPassword },
          }),
          403,
          'auth.forbidden',
        );
      const disabled = await api.send('POST', '/v1/auth/two-factor/disable', {
        browser: other,
        payload: { password: factorPassword },
      });
      expect(disabled.statusCode, disabled.payload).toBe(200);
      expect(
        (await api.send('GET', '/v1/users/me', { browser: user.browser }))
          .statusCode,
      ).toBe(200);
      const read = await api.send('GET', '/v1/auth/account-security', {
        browser: browserFrom(disabled),
      });
      expect(read.json()).toMatchObject({
        twoFactor: { enabled: false, recoveryCodesRemaining: null },
      });
      expect((await api.signIn(user.email)).session).toBeTruthy();
    });
  },
);

describe.skipIf(!betterAuthIntegrationEnabled)(
  'two-factor reset on the real API',
  () => {
    const { api, person, challenge, verify } = useFactorApi('2fa_reset');
    it('preserves the second factor after a password reset and blocks emailed codes and remembered devices', async () => {
      const user = await person();
      for (const path of ['send-otp', 'verify-otp'])
        expectProblem(
          await api.send('POST', `/v1/auth/two-factor/${path}`, {
            browser: user.browser,
            payload: { code: '123456' },
          }),
          404,
          'resource.not_found',
        );
      const cookie = await challenge(user.email);
      expectProblem(
        await api.send('POST', '/v1/auth/two-factor/verify-totp', {
          headers: { cookie },
          payload: { code: authenticatorCode(user.totpURI), trustDevice: true },
        }),
        400,
        'request.invalid',
      );
      const requested = await api.send(
        'POST',
        '/v1/auth/request-password-reset',
        { payload: { email: user.email, redirectTo: '/reset-password' } },
      );
      expect(requested.statusCode).toBe(200);
      const link = api.mailedLink(user.email, 'password_reset');
      const password = 'a different long integration password';
      const reset = await api.send(
        'POST',
        '/v1/auth/account-security/password/reset',
        {
          payload: {
            token: link.pathname.split('/').at(-1),
            newPassword: password,
          },
        },
      );
      expect(reset.statusCode, reset.payload).toBe(200);
      expect(
        (
          await verify(
            await challenge(user.email, password),
            authenticatorCode(user.totpURI),
          )
        ).statusCode,
      ).toBe(200);
    });
  },
);

describe.skipIf(!betterAuthIntegrationEnabled)(
  'two-factor lockout on the real API',
  () => {
    const { api, person, challenge, verify } = useFactorApi('2fa_lockout');
    it('enforces the plugin account lockout and resets expired failure counters after a successful code', async () => {
      const user = await person();
      for (let attempt = 0; attempt < 10; attempt++)
        expectProblem(
          await verify(await challenge(user.email), 'invalid'),
          401,
          'auth.unauthenticated',
        );
      expectProblem(
        await verify(
          await challenge(user.email),
          authenticatorCode(user.totpURI),
        ),
        429,
        'auth.two_factor_locked',
      );
      await api
        .database()
        .query(
          "update app.auth_two_factors set locked_until=clock_timestamp()-interval '1 second' where user_id=(select id from app.users where email=$1)",
          [user.email],
        );
      expect(
        (
          await verify(
            await challenge(user.email),
            authenticatorCode(user.totpURI),
          )
        ).statusCode,
      ).toBe(200);
      const state = await api
        .database()
        .query(
          'select failed_verification_count,locked_until from app.auth_two_factors where user_id=(select id from app.users where email=$1)',
          [user.email],
        );
      expect(state.rows).toEqual([
        { failed_verification_count: 0, locked_until: null },
      ]);
    });
  },
);

describe.skipIf(!betterAuthIntegrationEnabled)(
  'two-factor organization on the real API',
  () => {
    const { api, challenge, verify } = useFactorApi('2fa_org');
    it('refuses a pending code challenge after organization enforcement changes and still permits organization sign-in', async () => {
      const setup = await api.setup();
      await api.ready(setup);
      const email = `member@${setup.domain}`;
      await api.signUp(email, '/workspaces');
      const user = await enrollFactor(api, await api.signIn(email));
      const cookies = await Promise.all([challenge(email), challenge(email)]);
      await api.enforce(setup);
      for (const [index, cookie] of cookies.entries()) {
        const reply = await verify(
          cookie,
          index === 0
            ? authenticatorCode(user.totpURI)
            : (user.backupCodes[0] ?? ''),
          index === 1,
        );
        expectProblem(reply, 409, 'auth.conflict');
        expect(reply.headers['set-cookie'] ?? []).not.toContainEqual(
          expect.stringMatching(/^pertexo_session=[^;]/u),
        );
      }
      const session = await api.finish(
        await api.start(setup, api.person(email)),
      );
      expect(session.statusCode).toBe(302);
      expect(
        (
          await api.send('GET', '/v1/users/me', {
            browser: browserFrom(session),
          })
        ).statusCode,
      ).toBe(200);
    });
  },
);

describe.skipIf(!betterAuthIntegrationEnabled)(
  'distributed second-factor admission on the real API',
  () => {
    const api = useOrganizationApi('2fa_admit');
    it('charges password and both code routes to the same distributed origin budget', async () => {
      expectProblem(
        await api.send('POST', '/v1/auth/sign-in/email', {
          payload: { email: 'missing@example.test', password: factorPassword },
        }),
        401,
        'auth.unauthenticated',
      );
      for (let attempt = 0; attempt < 29; attempt++) {
        const path = attempt % 2 === 0 ? 'verify-totp' : 'verify-backup-code';
        expectProblem(
          await api.send('POST', `/v1/auth/two-factor/${path}`, {
            payload: { code: 'invalid' },
          }),
          401,
          'auth.unauthenticated',
        );
      }
      for (const path of ['verify-totp', 'verify-backup-code']) {
        const reply = await api.send('POST', `/v1/auth/two-factor/${path}`, {
          payload: { code: 'invalid' },
        });
        expectProblem(reply, 429, 'request.rate_limited');
        expect(Number(reply.headers['retry-after'])).toBeGreaterThan(0);
      }
    });
  },
);
