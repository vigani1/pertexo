import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  browserFrom,
  expectProblem,
} from '../../../support/better-auth/real-api.support.js';
import { useOrganizationApi } from './fixture.js';

describe.skipIf(!betterAuthIntegrationEnabled)(
  'organization policy races',
  () => {
    const api = useOrganizationApi('organization_races');
    it('rechecks required SSO after the native password session insert and removes a raced credential session', async () => {
      const fixture = await api.setup();
      const email = `racing@${fixture.domain}`;
      await api.signUp(email, '/workspaces');
      await api.ready(fixture);
      const owner = (
        await api
          .database()
          .query<{ id: string }>('select id from app.users where email=$1', [
            fixture.ownerEmail,
          ])
      ).rows[0];
      const user = (
        await api
          .database()
          .query<{ id: string }>('select id from app.users where email=$1', [
            email,
          ])
      ).rows[0];
      const database = (
        await api
          .database()
          .query<{ name: string }>('select current_database() name')
      ).rows[0];
      if (owner === undefined || user === undefined || database === undefined)
        throw new Error('Race fixture missing');
      const url = new URL(
        process.env.DATABASE_ADMIN_URL ??
          'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
      );
      url.pathname = '/' + database.name;
      const inspector = new Pool({ connectionString: url.toString(), max: 2 });
      const blocker = await inspector.connect();
      let pending: Promise<Awaited<ReturnType<typeof api.send>>> | undefined;
      try {
        // This disposable database trigger pauses SDK insertion, not application code.
        await inspector.query(
          `create function app.fixture_session_pause() returns trigger language plpgsql as $$ begin if new.user_id='${user.id}'::uuid then perform pg_advisory_xact_lock(704281,1); end if; return new; end $$`,
        );
        await inspector.query(
          'create trigger fixture_session_pause before insert on app.auth_sessions for each row execute function app.fixture_session_pause()',
        );
        await blocker.query('select pg_advisory_lock(704281,1)');
        pending = Promise.resolve(
          api.send('POST', '/v1/auth/sign-in/email', {
            payload: { email, password: 'a long enough integration password' },
          }),
        );
        await expect
          .poll(
            async () =>
              (
                await inspector.query<{ waiting: boolean }>(
                  "select exists(select 1 from pg_stat_activity where datname=current_database() and usename='pertexo_app' and wait_event='advisory') waiting",
                )
              ).rows[0]?.waiting,
            { timeout: 5000 },
          )
          .toBe(true);
        await api.identity().federation.store.configureEnforcement({
          workspaceId: fixture.workspaceId,
          actorId: owner.id,
          domainId: fixture.domainId,
          required: true,
          expectedRevision: 4,
          idempotencyKey: randomUUID(),
        });
        await blocker.query('select pg_advisory_unlock(704281,1)');
        const reply = await pending;
        expectProblem(reply, 409, 'auth.conflict');
        expect(reply.headers['set-cookie']).not.toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^pertexo_session=[^;]/u),
          ]),
        );
        expect(
          (
            await inspector.query(
              'select id from app.auth_sessions where user_id=$1',
              [user.id],
            )
          ).rows,
        ).toHaveLength(0);
      } finally {
        await blocker.query('select pg_advisory_unlock(704281,1)');
        await pending;
        await inspector.query(
          'drop trigger if exists fixture_session_pause on app.auth_sessions',
        );
        await inspector.query(
          'drop function if exists app.fixture_session_pause()',
        );
        blocker.release();
        await inspector.end();
      }
    });
    it('refuses an email-change proof issued before the domain began requiring SSO', async () => {
      const fixture = await api.setup();
      const email = `changing@${fixture.domain}`;
      await api.signUp(email, '/workspaces');
      const browser = await api.signIn(email);
      const started = await api.send('POST', '/v1/auth/change-email', {
        browser,
        payload: {
          newEmail: `outside-${randomUUID()}@example.test`,
          callbackURL: '/account/security',
        },
      });
      expect(started.statusCode, started.payload).toBe(200);
      const link = api.mailedLink(email, 'email_change_confirmation');
      await api.ready(fixture);
      await api.enforce(fixture);
      const completed = await api.send('GET', link.pathname + link.search);
      expect(completed.headers.location).toContain('error=');
      expect(
        (
          await api
            .database()
            .query('select email from app.users where email=$1', [email])
        ).rows,
      ).toEqual([{ email }]);
    });

    it('requires an alternative sign-in method before an organization-only account changes its primary email', async () => {
      const fixture = await api.setup();
      const browser = browserFrom(
        await api.finish(
          await api.start(fixture, api.person(`only@${fixture.domain}`)),
        ),
      );
      const change = {
        newEmail: `outside-${randomUUID()}@example.test`,
        callbackURL: '/account/security',
      };
      expectProblem(
        await api.send('POST', '/v1/auth/change-email', {
          browser,
          payload: change,
        }),
        403,
        'auth.alternative_required',
      );
      const configured = await api.send(
        'POST',
        '/v1/auth/account-security/password/setup',
        {
          browser,
          payload: { newPassword: 'another long integration password' },
        },
      );
      expect(configured.statusCode, configured.payload).toBe(200);
      const allowed = await api.send('POST', '/v1/auth/change-email', {
        browser: browserFrom(configured),
        payload: change,
      });
      expect(allowed.statusCode, allowed.payload).toBe(200);
      const oldProof = api.mailedLink(
        `only@${fixture.domain}`,
        'email_change_confirmation',
      );
      expect(
        (await api.send('GET', oldProof.pathname + oldProof.search)).headers
          .location,
      ).toContain('emailChangePending=true');
      const finalProof = api.mailedLink(change.newEmail, 'verification');
      const current = browserFrom(configured);
      const methods = (
        await api.send('GET', '/v1/auth/account-security', { browser: current })
      ).json<{ methods: { id: string; kind: string }[] }>().methods;
      const password = methods.find((method) => method.kind === 'password');
      if (password === undefined)
        throw new Error('Alternative password missing');
      const removed = await api.send(
        'POST',
        '/v1/auth/account-security/methods/unlink',
        { browser: current, payload: { methodId: password.id } },
      );
      expect(removed.statusCode, removed.payload).toBe(200);

      expect(
        (await api.send('GET', finalProof.pathname + finalProof.search)).headers
          .location,
      ).toContain('error=verification_invalid');
    });
  },
);
