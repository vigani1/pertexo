import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  browserFrom,
} from '../../support/better-auth/real-api.support.js';
import {
  useRecoveryApi,
  originalPassword,
  replacementPassword,
  waitForBlocked,
} from './account-recovery.fixture.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'outstanding password reset capabilities',
  () => {
    const api = useRecoveryApi();
    it('consumes all sibling links and keeps the winning password and unrelated proofs', async () => {
      const person = await api.account();
      const first = await api.link(person.email),
        second = await api.link(person.email);
      expect(first).not.toBe(second);
      const preserved = await api.unrelatedProof(person.userId);
      expect((await api.reset(first)).statusCode).toBe(200);
      for (const token of [second, first])
        expect((await api.reset(token, originalPassword)).statusCode).toBe(400);
      // The old password is refused (400); a 401 means only no session.
      expect(
        (await api.signInWith(person.email, originalPassword)).statusCode,
      ).toBe(400);
      expect(
        (await api.signInWith(person.email, replacementPassword)).statusCode,
      ).toBe(200);
      expect(
        (await api.send('GET', '/v1/users/me', { browser: person.browser }))
          .statusCode,
      ).toBe(401);
      await preserved();
    });
    it('invalidates old reset links after an authenticated password change', async () => {
      const person = await api.account(),
        token = await api.link(person.email);
      const preserved = await api.unrelatedProof(person.userId);
      const changed = await api.send(
        'POST',
        '/v1/auth/account-security/password/change',
        {
          browser: person.browser,
          payload: {
            currentPassword: originalPassword,
            newPassword: replacementPassword,
          },
        },
      );
      expect(changed.statusCode, changed.payload).toBe(200);
      expect((await api.reset(token, originalPassword)).statusCode).toBe(400);
      expect(
        (await api.signInWith(person.email, replacementPassword)).statusCode,
      ).toBe(200);
      expect(
        (
          await api.send('GET', '/v1/users/me', {
            browser: browserFrom(changed),
          })
        ).statusCode,
      ).toBe(200);
      await preserved();
    });
    it('invalidates reset links only on completed recovery email change', async () => {
      const person = await api.account(),
        token = await api.link(person.email);
      const preserved = await api.unrelatedProof(person.userId);
      const newEmail = `changed-${randomUUID()}@example.test`;
      const change = await api.send('POST', '/v1/auth/change-email', {
        browser: person.browser,
        payload: { newEmail, callbackURL: '/login?emailChanged=true' },
      });
      expect(change.statusCode, change.payload).toBe(200);
      const old = api.mailedLink(person.email, 'email_change_confirmation');
      expect(
        (
          await api.send('GET', old.pathname + old.search, {
            browser: person.browser,
          })
        ).headers.location,
      ).toContain('emailChangePending=true');
      const fresh = api.mailedLink(newEmail, 'verification');
      expect(
        (
          await api.send('GET', fresh.pathname + fresh.search, {
            browser: person.browser,
          })
        ).headers.location,
      ).toContain('emailChanged=true');
      expect((await api.reset(token, replacementPassword)).statusCode).toBe(
        400,
      );
      expect(
        (await api.signInWith(newEmail, originalPassword)).statusCode,
      ).toBe(200);
      await preserved();
    });
    it('keeps outstanding reset capabilities after a refused password change', async () => {
      const person = await api.account(),
        token = await api.link(person.email);
      const before = await api.state(person.userId);
      const refused = await api.send(
        'POST',
        '/v1/auth/account-security/password/change',
        {
          browser: person.browser,
          payload: {
            currentPassword: 'wrong-password',
            newPassword: replacementPassword,
          },
        },
      );
      expect(refused.statusCode).toBe(400);
      expect(await api.state(person.userId)).toEqual(before);
      expect((await api.reset(token)).statusCode).toBe(200);
    });
    it('serializes sibling resets waiting on the same user: one winner, no deadlock or overwrite', async () => {
      const person = await api.account();
      const tokens = [
        await api.link(person.email),
        await api.link(person.email),
      ];
      const passwords = [
        replacementPassword,
        'another independently chosen password',
      ];
      const lock = await api.database().connect();
      let pending: ReturnType<typeof api.reset>[] = [];
      try {
        await lock.query('begin');
        const {
          rows: [row],
        } = await lock.query<{ pid: number }>('select pg_backend_pid() pid');
        if (row === undefined) throw new Error('No lock backend');
        await lock.query('select id from app.users where id=$1 for update', [
          person.userId,
        ]);
        pending = tokens.map((token, index) =>
          api.reset(token, passwords[index]),
        );
        // The inspection pool has one connection; use a separate observer while holding it.
        const observer = new Pool({ ...api.database().options, max: 1 });
        try {
          await waitForBlocked(observer, row.pid, 2);
        } finally {
          await observer.end();
        }
        await lock.query('commit');
      } finally {
        await lock.query('rollback');
        lock.release();
      }
      const responses = await Promise.all(pending);
      expect(responses.map((reply) => reply.statusCode).sort()).toEqual([
        200, 400,
      ]);
      for (const [index, password] of passwords.entries()) {
        expect((await api.signInWith(person.email, password)).statusCode).toBe(
          responses[index]?.statusCode === 200 ? 200 : 400,
        );
      }
    });

    it.each(['password', 'email'] as const)(
      'does not let a queued reset overwrite a committed %s change',
      async (kind) => {
        const person = await api.account(),
          token = await api.link(person.email);
        const newEmail = `raced-${randomUUID()}@example.test`;
        let emailLink: URL | undefined;
        if (kind === 'email') {
          expect(
            (
              await api.send('POST', '/v1/auth/change-email', {
                browser: person.browser,
                payload: { newEmail, callbackURL: '/login?emailChanged=true' },
              })
            ).statusCode,
          ).toBe(200);
          const old = api.mailedLink(person.email, 'email_change_confirmation');
          await api.send('GET', old.pathname + old.search, {
            browser: person.browser,
          });
          emailLink = api.mailedLink(newEmail, 'verification');
        }
        const observer = new Pool({ ...api.database().options, max: 1 });
        const lock = await api.database().connect();
        let change: ReturnType<typeof api.send> | undefined,
          reset: ReturnType<typeof api.reset> | undefined;
        try {
          await lock.query('begin');
          const {
            rows: [row],
          } = await lock.query<{ pid: number }>('select pg_backend_pid() pid');
          if (row === undefined) throw new Error('No lock backend');
          await lock.query('select id from app.users where id=$1 for update', [
            person.userId,
          ]);
          change =
            emailLink === undefined
              ? api.send('POST', '/v1/auth/account-security/password/change', {
                  browser: person.browser,
                  payload: {
                    currentPassword: originalPassword,
                    newPassword: replacementPassword,
                  },
                })
              : api.send('GET', emailLink.pathname + emailLink.search, {
                  browser: person.browser,
                });
          await waitForBlocked(observer, row.pid, 1);
          reset = api.reset(token, 'password chosen by old reset link');
          await waitForBlocked(observer, row.pid, 2);
          await lock.query('commit');
        } finally {
          await lock.query('rollback');
          lock.release();
          await observer.end();
        }
        expect((await change).statusCode).toBe(kind === 'password' ? 200 : 302);
        expect((await reset).statusCode).toBe(400);
        expect(
          (
            await api.signInWith(
              kind === 'password' ? person.email : newEmail,
              kind === 'password' ? replacementPassword : originalPassword,
            )
          ).statusCode,
        ).toBe(200);
      },
    );
    it('rolls back password, sessions and every reset proof when revocation fails', async () => {
      const person = await api.account(),
        first = await api.link(person.email),
        second = await api.link(person.email);
      const before = await api.state(person.userId);
      await api
        .database()
        .query(
          `create function app.refuse_recovery_revocation() returns trigger language plpgsql as $$ begin raise exception 'fixture revocation refused'; end $$`,
        );
      await api
        .database()
        .query(
          `create trigger refuse_recovery_revocation before delete on app.auth_sessions for each row execute function app.refuse_recovery_revocation()`,
        );
      try {
        expect((await api.reset(first)).statusCode).toBe(500);
      } finally {
        await api
          .database()
          .query(
            'drop trigger refuse_recovery_revocation on app.auth_sessions',
          );
        await api
          .database()
          .query('drop function app.refuse_recovery_revocation()');
      }
      expect(await api.state(person.userId)).toEqual(before);
      expect((await api.reset(second)).statusCode).toBe(200);
    });
  },
);
