import { createTwoFactorRecoveryStore } from '@pertexo/core/identity';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  browserFrom,
  expectProblem,
} from '../../support/better-auth/real-api.support.js';
import { useOrganizationApi } from '../federation/organization/fixture.js';
import {
  authenticatorCode,
  challengeCookie,
  enrollFactor,
  factorPassword,
} from '../../support/better-auth/two-factor.js';

describe.skipIf(!betterAuthIntegrationEnabled)(
  'two-factor security notices',
  () => {
    const api = useOrganizationApi('2fa_notices');
    async function person() {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      return { email, ...(await enrollFactor(api, await api.signIn(email))) };
    }
    async function challenge(email: string) {
      const reply = await api.send('POST', '/v1/auth/sign-in/email', {
        payload: { email, password: factorPassword },
      });
      expect(reply.statusCode, reply.payload).toBe(200);
      return challengeCookie(reply);
    }
    it('notifies only a successful recovery-code sign-in, never enrollment, ordinary TOTP or a refused code', async () => {
      const user = await person();
      const notices = () =>
        api
          .mailedMessages(user.email)
          .filter((message) => message.purpose === 'recovery_code_sign_in');
      const verify = (
        cookie: string,
        code: string,
        method = 'verify-backup-code',
      ) =>
        api.send('POST', `/v1/auth/two-factor/${method}`, {
          headers: { cookie },
          payload: { code },
        });
      expectProblem(
        await verify(await challenge(user.email), 'invalid-code'),
        401,
        'auth.unauthenticated',
      );
      const counter = await api
        .database()
        .query<{ failed_verification_count: number }>(
          'select failed_verification_count from app.auth_two_factors where user_id=(select id from app.users where email=$1)',
          [user.email],
        );
      expect(counter.rows).toEqual([{ failed_verification_count: 1 }]);
      expect(
        (
          await verify(
            await challenge(user.email),
            authenticatorCode(user.totpURI),
            'verify-totp',
          )
        ).statusCode,
      ).toBe(200);
      expect(notices()).toHaveLength(0);
      const code = user.backupCodes[0];
      if (code === undefined) throw new Error('Recovery code missing');
      const accepted = await verify(await challenge(user.email), code);
      expect(accepted.statusCode, accepted.payload).toBe(200);
      expect(notices()).toHaveLength(1);
      expect(new URL(notices()[0]?.url ?? '').pathname).toBe(
        '/account/security',
      );
      expect(new URL(notices()[0]?.url ?? '').search).toBe('');
      expect(JSON.stringify(notices())).not.toContain(code);
      expect(JSON.stringify(notices())).not.toContain(user.totpURI);
      expectProblem(
        await verify(await challenge(user.email), code),
        401,
        'auth.unauthenticated',
      );
      expect(notices()).toHaveLength(1);
      const facts = await api
        .database()
        .query(
          "select event_type from app.identity_security_audit_facts facts join app.users users on users.id=facts.user_id where users.email=$1 and event_type='two_factor.recovery_code_used'",
          [user.email],
        );
      expect(facts.rows).toEqual([
        { event_type: 'two_factor.recovery_code_used' },
      ]);
    });
    it('notifies and records a disable once, but not a wrong password or an already-disabled factor', async () => {
      const user = await person();
      const notices = () =>
        api
          .mailedMessages(user.email)
          .filter((message) => message.purpose === 'two_factor_disabled');
      expectProblem(
        await api.send('POST', '/v1/auth/two-factor/disable', {
          browser: user.browser,
          payload: { password: 'wrong-password' },
        }),
        400,
        'request.invalid',
      );
      expect(notices()).toHaveLength(0);
      const disabled = await api.send('POST', '/v1/auth/two-factor/disable', {
        browser: user.browser,
        payload: { password: factorPassword },
      });
      expect(disabled.statusCode, disabled.payload).toBe(200);
      expect(notices()).toHaveLength(1);
      expect(JSON.stringify(notices())).not.toContain(user.totpURI);
      const again = await api.send('POST', '/v1/auth/two-factor/disable', {
        browser: browserFrom(disabled),
        payload: { password: factorPassword },
      });
      expect(again.statusCode, again.payload).toBe(200);
      expect(notices()).toHaveLength(1);
      const facts = await api
        .database()
        .query(
          "select event_type from app.identity_security_audit_facts facts join app.users users on users.id=facts.user_id where users.email=$1 and event_type='two_factor.disabled'",
          [user.email],
        );
      expect(facts.rows).toEqual([{ event_type: 'two_factor.disabled' }]);
    });
    it('restores password sign-in after privileged removal with the application login', async () => {
      const user = await person();
      const database = await api
        .database()
        .query<{ name: string }>('select current_database() name');
      const name = database.rows[0]?.name;
      if (name === undefined) throw new Error('Fixture database missing');
      const url = new URL(
        process.env.DATABASE_URL ??
          'postgresql://pertexo_app:pertexo-local-app@localhost:5432/postgres',
      );
      url.pathname = `/${name}`;
      const store = createTwoFactorRecoveryStore(
        parseDatabaseConfig({ connectionString: url.toString(), max: 1 }),
      );
      try {
        expect(await store.disable(user.email, () => undefined)).toEqual({
          status: 'disabled',
          email: user.email,
        });
        const browser = await api.signIn(user.email);
        const read = await api.send('GET', '/v1/auth/account-security', {
          browser,
        });
        expect(read.statusCode, read.payload).toBe(200);
        expect(read.json()).toMatchObject({
          twoFactor: { enabled: false, recoveryCodesRemaining: null },
        });
      } finally {
        await store.close();
      }
    });
  },
);
