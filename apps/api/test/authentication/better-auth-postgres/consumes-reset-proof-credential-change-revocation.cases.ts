import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { expect, it } from 'vitest';

import {
  adminUrl,
  databaseUrl,
  mailedMessages,
  runtime,
  authRequest,
  cookieValue,
} from './fixture.js';

export function registerConsumesResetProofCredentialChangeRevocation(): void {
  it('consumes reset proof with credential change and revocation in one commit', async () => {
    const email = 'atomic-reset@example.test';
    const initialPassword = 'atomic reset original password';
    const replacementPassword = 'atomic reset replacement password';
    expect(
      (
        await authRequest('/v1/auth/sign-up/email', {
          name: 'Atomic Reset',
          email,
          password: initialPassword,
          callbackURL: '/login',
        })
      ).status,
    ).toBe(200);
    const verification = mailedMessages(email).find(
      (message) => message.purpose === 'verification',
    );
    await runtime.auth.handler(
      new Request(verification?.url ?? 'http://invalid', {
        headers: { origin: 'http://pertexo.test' },
        redirect: 'manual',
      }),
    );
    const signedIn = await authRequest('/v1/auth/sign-in/email', {
      email,
      password: initialPassword,
      callbackURL: '/workspaces',
    });
    const oldCookie = cookieValue(signedIn.headers.getSetCookie()) ?? '';
    expect(oldCookie).not.toBe('');
    expect(
      (
        await authRequest('/v1/auth/request-password-reset', {
          email,
          redirectTo: '/reset-password',
        })
      ).status,
    ).toBe(200);
    const resetMail = mailedMessages(email).find(
      (message) => message.purpose === 'password_reset',
    );
    expect(resetMail).toBeDefined();
    const token =
      new URL(resetMail?.url ?? 'http://invalid').pathname.split('/').at(-1) ??
      '';
    expect(token.length).toBeGreaterThan(10);

    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    try {
      await owner.query(`create function app.test_reject_reset_revocation()
        returns trigger language plpgsql as $$
        begin raise exception 'test reset revocation failure'; end;
        $$`);
      await owner.query(`create trigger test_reject_reset_revocation
        before delete on app.auth_sessions for each row
        execute function app.test_reject_reset_revocation()`);
      const failed = await authRequest(
        '/v1/auth/account-security/password/reset',
        {
          token,
          newPassword: replacementPassword,
        },
      );
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await runtime.sessions.authenticate(oldCookie)).toBeDefined();
    } finally {
      await owner.query(
        'drop trigger if exists test_reject_reset_revocation on app.auth_sessions',
      );
      await owner.query(
        'drop function if exists app.test_reject_reset_revocation()',
      );
      await owner.end();
    }

    const competing = await Promise.all([
      authRequest('/v1/auth/account-security/password/reset', {
        token,
        newPassword: replacementPassword,
      }),
      authRequest('/v1/auth/account-security/password/reset', {
        token,
        newPassword: replacementPassword,
      }),
    ]);
    expect(competing.map((response) => response.status).sort()).toEqual([
      200, 400,
    ]);
    expect(
      (
        await authRequest('/v1/auth/reset-password', {
          token,
          newPassword: initialPassword,
        })
      ).status,
    ).toBe(404);
    expect(await runtime.sessions.authenticate(oldCookie)).toBeUndefined();
    expect(
      (
        await authRequest('/v1/auth/sign-in/email', {
          email,
          password: initialPassword,
          callbackURL: '/workspaces',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await authRequest('/v1/auth/sign-in/email', {
          email,
          password: replacementPassword,
          callbackURL: '/workspaces',
        })
      ).status,
    ).toBe(200);
  });

  it('does not deliver reset mail or create a password method for social-only users', async () => {
    const userId = randomUUID();
    const email = 'social-reset@example.test';
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    try {
      await owner.query(
        `insert into app.users(id,email,display_name,email_verified)
         values($1,$2,'Social Reset',true)`,
        [userId, email],
      );
      await owner.query(
        `insert into app.auth_accounts(id,account_id,provider_id,user_id)
         values($1,'social-reset-subject','google',$2)`,
        [randomUUID(), userId],
      );
      const response = await authRequest('/v1/auth/request-password-reset', {
        email,
        redirectTo: '/reset-password',
      });
      expect(response.status).toBe(200);
      expect(
        mailedMessages(email).filter(
          (message) => message.purpose === 'password_reset',
        ),
      ).toHaveLength(0);
      const methods = await owner.query<{ provider_id: string }>(
        'select provider_id from app.auth_accounts where user_id=$1',
        [userId],
      );
      expect(methods.rows).toEqual([{ provider_id: 'google' }]);
    } finally {
      await owner.end();
    }
  });
}
