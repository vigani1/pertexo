import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { expect, it } from 'vitest';

import {
  adminUrl,
  databaseUrl,
  apiUrl,
  mailedMessages,
  runtime,
  authRequest,
  cookieValue,
  authenticatedRequest,
} from '../fixture.js';

export function registerRollsBackPasswordChangeSessionRevocation(): void {
  it('rolls back a password change when session revocation fails', async () => {
    const email = 'rollback-password@example.test';
    const originalPassword = 'original correct horse battery staple';
    const newPassword = 'replacement correct horse battery staple';
    const signUp = await authRequest('/v1/auth/sign-up/email', {
      name: 'Rollback Test',
      email,
      password: originalPassword,
      callbackURL: '/login',
    });
    expect(signUp.status).toBe(200);
    const verification = mailedMessages(email).find(
      (message) => message.purpose === 'verification',
    );
    expect(verification).toBeDefined();
    await runtime.auth.handler(
      new Request(verification?.url ?? 'http://invalid', {
        headers: { origin: 'http://pertexo.test' },
        redirect: 'manual',
      }),
    );
    const signIn = await authRequest('/v1/auth/sign-in/email', {
      email,
      password: originalPassword,
      callbackURL: '/workspaces',
    });
    expect(signIn.status).toBe(200);
    const signedCookie = cookieValue(signIn.headers.getSetCookie()) ?? '';
    const authenticated = await runtime.sessions.authenticate(signedCookie);
    expect(authenticated).toBeDefined();
    if (authenticated === undefined)
      throw new Error('Expected an authenticated session');

    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    try {
      await owner.query(`create function app.test_reject_auth_session_delete()
        returns trigger language plpgsql as $$
        begin
          if old.user_id::text=TG_ARGV[0] then
            raise exception 'test revocation failure';
          end if;
          return old;
        end;
        $$`);
      await owner.query(`create trigger test_reject_auth_session_delete
        before delete on app.auth_sessions for each row
        execute function app.test_reject_auth_session_delete('${authenticated.userId}')`);
      const rejected = await authenticatedRequest({
        path: '/v1/auth/account-security/password/change',
        method: 'POST',
        sessionCookie: signedCookie,
        csrf: 'test-csrf-token-with-more-than-thirty-two-characters',
        body: { currentPassword: originalPassword, newPassword },
      });
      expect(rejected.status).toBeGreaterThanOrEqual(500);
      expect(await runtime.sessions.authenticate(signedCookie)).toBeDefined();
    } finally {
      await owner.query(
        'drop trigger if exists test_reject_auth_session_delete on app.auth_sessions',
      );
      await owner.query(
        'drop function if exists app.test_reject_auth_session_delete()',
      );
      await owner.end();
    }
    expect(
      (
        await authRequest('/v1/auth/sign-in/email', {
          email,
          password: originalPassword,
          callbackURL: '/workspaces',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await authRequest('/v1/auth/sign-in/email', {
          email,
          password: newPassword,
          callbackURL: '/workspaces',
        })
      ).status,
    ).toBe(401);
  });

  it('serializes competing password setup commands and revokes the old session once', async () => {
    const userId = randomUUID();
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    try {
      await owner.query(
        `insert into app.users(id,email,display_name,email_verified)
         values($1,'social-setup@example.test','Social Setup',true)`,
        [userId],
      );
      await owner.query(
        `insert into app.auth_accounts(id,account_id,provider_id,user_id)
         values($1,'provider-subject','google',$2)`,
        [randomUUID(), userId],
      );
    } finally {
      await owner.end();
    }
    const initial = await runtime.sessions.issue(userId);
    const cookie = cookieValue(initial.setCookies) ?? '';
    const csrf = 'test-csrf-token-with-more-than-thirty-two-characters';
    const results = await Promise.all([
      authenticatedRequest({
        path: '/v1/auth/account-security/password/setup',
        method: 'POST',
        sessionCookie: cookie,
        csrf: csrf,
        body: {
          newPassword: 'social setup secure password one',
        },
      }),
      authenticatedRequest({
        path: '/v1/auth/account-security/password/setup',
        method: 'POST',
        sessionCookie: cookie,
        csrf: csrf,
        body: {
          newPassword: 'social setup secure password two',
        },
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results.find((result) => result.status === 200);
    const replacement = cookieValue(winner?.headers.getSetCookie() ?? []);
    expect(await runtime.sessions.authenticate(cookie)).toBeUndefined();
    expect(
      await runtime.sessions.authenticate(replacement ?? ''),
    ).toBeDefined();

    const api = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      const accounts = await api.query<{ count: number }>(
        `select count(*)::integer count from app.auth_accounts
          where user_id=$1 and provider_id='credential'`,
        [userId],
      );
      expect(accounts.rows).toEqual([{ count: 1 }]);
      const active = await api.query<{ count: number }>(
        'select count(*)::integer count from app.auth_sessions where user_id=$1',
        [userId],
      );
      expect(active.rows).toEqual([{ count: 1 }]);
    } finally {
      await api.end();
    }
  });
}
