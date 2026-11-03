import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  betterAuthIntegrationEnabled,
  browserFrom,
  useBetterAuthRealApi,
  type Browser,
} from '../support/better-auth/real-api.support.js';
import {
  databaseBarrier,
  waitForDatabaseBlock,
} from '../support/postgres-barrier.js';

// These journeys exercise mounted auth endpoints and inspect only committed account truth.
describe.runIf(betterAuthIntegrationEnabled)(
  'reset links across account changes',
  () => {
    const api = useBetterAuthRealApi('reset_lifecycle', {
      socialProviders: {
        google: { clientId: 'fixture-client', clientSecret: 'fixture-secret' },
      },
    });
    const requestReset = (email: string) =>
      api.send('POST', '/v1/auth/request-password-reset', {
        payload: { email, redirectTo: '/reset-password' },
      });
    const reset = (token: string) =>
      api.send('POST', '/v1/auth/account-security/password/reset', {
        payload: { token, newPassword: 'unwanted replacement password' },
      });
    const follow = (url: URL, browser: Browser) =>
      api.send('GET', url.pathname + url.search, { browser });

    async function account() {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/login?verified=true');
      const browser = await api.signIn(email);
      const userId = (await api.send('GET', '/v1/users/me', { browser })).json<{
        id: string;
      }>().id;
      return { email, browser, userId };
    }

    async function changeLink(email: string, browser: Browser) {
      const nextEmail = `${randomUUID()}@example.test`;
      const started = await api.send('POST', '/v1/auth/change-email', {
        browser,
        payload: {
          newEmail: nextEmail,
          callbackURL: '/login?emailChanged=true',
        },
      });
      expect(started.statusCode, started.payload).toBe(200);
      expect(
        (
          await follow(
            api.mailedLink(email, 'email_change_confirmation'),
            browser,
          )
        ).statusCode,
      ).toBe(302);
      return { nextEmail, link: api.mailedLink(nextEmail, 'verification') };
    }

    async function proofCount(userId: string) {
      return (
        await api
          .database()
          .query<{ count: number }>(
            "select count(*)::int count from app.auth_verifications where value=$1 and identifier like 'reset-password:%'",
            [userId],
          )
      ).rows[0]?.count;
    }

    it('rechecks the requested address after waiting for a committing email change', async () => {
      const { email, browser, userId } = await account();
      const { nextEmail, link } = await changeLink(email, browser);
      const barrier = await databaseBarrier(api.database());
      await api.database().query<
        Record<string, unknown>
      >(`create function public.hold_changed_email() returns trigger language plpgsql as $$
      begin if NEW.email<>OLD.email then perform pg_advisory_xact_lock(2700,1); end if; return NEW; end $$;
      create trigger hold_changed_email before update on app.users for each row execute function public.hold_changed_email()`);
      let changing: Promise<unknown> | undefined;
      let issuing: ReturnType<typeof requestReset> | undefined;
      try {
        await barrier.holder.query('select pg_advisory_xact_lock(2700,1)');
        changing = follow(link, browser);
        await waitForDatabaseBlock(api.database(), barrier.pid, 'users');
        issuing = requestReset(email);
        // The reset must reach its user-row fence, not merely remain scheduled in JavaScript.
        await expect
          .poll(
            async () =>
              (
                await api.database().query<{
                  count: number;
                }>(`select count(*)::int count from pg_stat_activity
        where datname=current_database() and wait_event_type='Lock' and query like '%"app"."users"%'`)
              ).rows[0]?.count,
          )
          .toBeGreaterThanOrEqual(2);
        await barrier.holder.query('commit');
        await changing;
        const response = await issuing;
        const unknown = await requestReset(`${randomUUID()}@example.test`);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(unknown.json());
        expect(await proofCount(userId)).toBe(0);
        expect(
          api
            .mailedMessages(email)
            .filter((m) => m.purpose === 'password_reset'),
        ).toEqual([]);
        expect((await requestReset(nextEmail)).statusCode).toBe(200);
        expect(await proofCount(userId)).toBe(1);
      } finally {
        await barrier.close();
        await Promise.allSettled([changing, issuing]);
        await api
          .database()
          .query<Record<string, unknown>>(
            'drop trigger hold_changed_email on app.users; drop function public.hold_changed_email()',
          );
      }
    });

    it('invalidates issuance that entered before the email change instead of reviving its link after invalidation', async () => {
      const { email, browser, userId } = await account();
      const { link } = await changeLink(email, browser);
      const barrier = await databaseBarrier(api.database());
      await api.database().query<
        Record<string, unknown>
      >(`create function public.hold_reset_insert() returns trigger language plpgsql as $$
      begin if NEW.identifier like 'reset-password:%' then perform pg_advisory_xact_lock(2700,2); end if; return NEW; end $$;
      create trigger hold_reset_insert before insert on app.auth_verifications for each row execute function public.hold_reset_insert()`);
      let issuing: ReturnType<typeof requestReset> | undefined;
      let changing: Promise<unknown> | undefined;
      try {
        await barrier.holder.query('select pg_advisory_xact_lock(2700,2)');
        issuing = requestReset(email);
        await waitForDatabaseBlock(
          api.database(),
          barrier.pid,
          'auth_verifications',
        );
        let changed = false;
        changing = follow(link, browser).finally(() => {
          changed = true;
        });
        await expect
          .poll(
            async () =>
              changed ||
              Number(
                (
                  await api.database().query<{
                    count: number;
                  }>(`select count(*)::int count from pg_stat_activity
        where datname=current_database() and wait_event_type='Lock'`)
                ).rows[0]?.count,
              ) >= 2,
          )
          .toBe(true);
        await barrier.holder.query('commit');
        await Promise.all([issuing, changing]);
        expect(await proofCount(userId)).toBe(0);
        const token =
          api.mailedLink(email, 'password_reset').pathname.split('/').at(-1) ??
          '';
        const refused = await reset(token);
        expect(refused.statusCode, refused.payload).toBe(400);
      } finally {
        await barrier.close();
        await Promise.allSettled([issuing, changing]);
        await api
          .database()
          .query<Record<string, unknown>>(
            'drop trigger hold_reset_insert on app.auth_verifications; drop function public.hold_reset_insert()',
          );
      }
    });

    it('never revives an old reset link after password removal and replacement setup', async () => {
      const { email, browser, userId } = await account();
      await requestReset(email);
      const token =
        api.mailedLink(email, 'password_reset').pathname.split('/').at(-1) ??
        '';
      const method = (
        await api
          .database()
          .query<{ id: string }>(
            "select id from app.auth_accounts where user_id=$1 and provider_id='credential'",
            [userId],
          )
      ).rows[0];
      // A configured outside sign-in method keeps removal a supported account transition.
      await api
        .database()
        .query<Record<string, unknown>>(
          "insert into app.auth_accounts(id,user_id,account_id,provider_id) values($1,$2,$3,'google')",
          [randomUUID(), userId, randomUUID()],
        );
      const unlinked = await api.send(
        'POST',
        '/v1/auth/account-security/methods/unlink',
        { browser, payload: { methodId: method?.id } },
      );
      expect(unlinked.statusCode, unlinked.payload).toBe(200);
      expect(await proofCount(userId)).toBe(0);
      expect((await reset(token)).statusCode).toBe(400);
      const replacement = await api.send(
        'POST',
        '/v1/auth/account-security/password/setup',
        {
          browser: browserFrom(unlinked),
          payload: { newPassword: 'newly secured replacement password' },
        },
      );
      expect(replacement.statusCode, replacement.payload).toBe(200);
      const snapshot = async () =>
        (
          await api.database().query<Record<string, unknown>>(
            `select
      (select jsonb_agg(to_jsonb(a)) from app.auth_accounts a where user_id=$1) accounts,
      (select jsonb_agg(to_jsonb(s)) from app.auth_sessions s where user_id=$1) sessions`,
            [userId],
          )
        ).rows;
      const before = await snapshot();
      expect((await reset(token)).statusCode).toBe(400);
      expect(await snapshot()).toEqual(before);
    });
    it('invalidates pre-existing links when setting up a password independently of removal', async () => {
      const { email, browser, userId } = await account();
      await requestReset(email);
      const token =
        api.mailedLink(email, 'password_reset').pathname.split('/').at(-1) ??
        '';
      // An upgraded account can retain a proof from before password removal was fixed.
      await api
        .database()
        .query<Record<string, unknown>>(
          "delete from app.auth_accounts where user_id=$1 and provider_id='credential'",
          [userId],
        );
      const setup = await api.send(
        'POST',
        '/v1/auth/account-security/password/setup',
        {
          browser,
          payload: { newPassword: 'newly configured secure password' },
        },
      );
      expect(setup.statusCode, setup.payload).toBe(200);
      expect(await proofCount(userId)).toBe(0);
      expect((await reset(token)).statusCode).toBe(400);
      expect(
        (await api.send('GET', '/v1/users/me', { browser: browserFrom(setup) }))
          .statusCode,
      ).toBe(200);
    });

    it.each(['suspended', 'deleted', 'no-password'])(
      'does not issue reset proofs or mail to an ineligible %s account',
      async (eligibility) => {
        const { email, userId } = await account();
        if (eligibility === 'no-password')
          await api
            .database()
            .query<Record<string, unknown>>(
              "delete from app.auth_accounts where user_id=$1 and provider_id='credential'",
              [userId],
            );
        else
          await api
            .database()
            .query('update app.users set status=$2 where id=$1', [
              userId,
              eligibility,
            ]);
        const response = await requestReset(email);
        const unknown = await requestReset(`${randomUUID()}@example.test`);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(unknown.json());
        expect(await proofCount(userId)).toBe(0);
        expect(
          api
            .mailedMessages(email)
            .filter((m) => m.purpose === 'password_reset'),
        ).toEqual([]);
      },
    );
  },
);
