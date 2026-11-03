import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Pool } from 'pg';
import { useBetterAuthRealApi } from '../../support/better-auth/real-api.support.js';

export const originalPassword = 'a long enough integration password';
export const replacementPassword = 'a different secure recovery password';
export function useRecoveryApi() {
  const api = useBetterAuthRealApi('recovery_regressions');
  async function account() {
    const email = `recovery-${randomUUID()}@example.test`;
    await api.signUp(email, '/workspaces');
    const browser = await api.signIn(email);
    const {
      rows: [user],
    } = await api
      .database()
      .query<{ id: string }>('select id from app.users where email=$1', [
        email,
      ]);
    if (user === undefined) throw new Error('Fixture user missing');
    return { email, browser, userId: user.id };
  }
  async function link(email: string) {
    const reply = await api.send('POST', '/v1/auth/request-password-reset', {
      payload: { email, redirectTo: '/reset-password' },
    });
    expect(reply.statusCode, reply.payload).toBe(200);
    const token = api
      .mailedLink(email, 'password_reset')
      .pathname.split('/')
      .at(-1);
    if (token === undefined) throw new Error('Reset token missing');
    return token;
  }
  const reset = (token: string, newPassword = replacementPassword) =>
    api.send('POST', '/v1/auth/account-security/password/reset', {
      payload: { token, newPassword },
    });
  const signIn = (email: string, password: string) =>
    api.send('POST', '/v1/auth/sign-in/email', {
      payload: { email, password, callbackURL: '/workspaces' },
    });
  async function state(userId: string) {
    return (
      await api.database().query<{
        password: string;
        sessions: string[] | null;
        proofs: string[] | null;
      }>(
        `select (select password from app.auth_accounts where user_id=$1 and provider_id='credential') password,
       (select jsonb_agg(id order by id) from app.auth_sessions where user_id=$1) sessions,
       (select jsonb_agg(id order by id) from app.auth_verifications where value=$1::text) proofs`,
        [userId],
      )
    ).rows;
  }
  async function unrelatedProof(userId: string) {
    const id = randomUUID();
    await api.database().query(
      `insert into app.auth_verifications(id,identifier,value,expires_at)
       values($1,$2,$3,clock_timestamp()+interval '1 hour')`,
      [id, `other-purpose:${id}`, userId],
    );
    return async () => {
      expect(
        (
          await api
            .database()
            .query('select id from app.auth_verifications where id=$1', [id])
        ).rows,
      ).toEqual([{ id }]);
    };
  }
  return {
    ...api,
    account,
    link,
    reset,
    signInWith: signIn,
    state,
    unrelatedProof,
  };
}

export async function waitForBlocked(
  pool: Pool,
  blocker: number,
  count: number,
) {
  await expect
    .poll(
      async () =>
        (
          await pool.query<{ count: number }>(
            `with recursive blocked(pid) as (
       select pid from pg_stat_activity where datname=current_database() and $1=any(pg_blocking_pids(pid))
       union select activity.pid from pg_stat_activity activity join blocked on blocked.pid=any(pg_blocking_pids(activity.pid))
     ) select count(*)::int count from blocked`,
            [blocker],
          )
        ).rows[0]?.count,
      { timeout: 10_000 },
    )
    .toBe(count);
}
