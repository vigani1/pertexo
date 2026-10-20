import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  expectProblem,
} from '../../support/better-auth/real-api.support.js';
import {
  authenticatorCode,
  challengeCookie,
  enrollFactor,
  factorPassword,
} from '../../support/better-auth/two-factor.js';
import { useOrganizationApi } from '../federation/organization/fixture.js';

describe.skipIf(!betterAuthIntegrationEnabled)(
  'organization enforcement during second-factor session insertion',
  () => {
    const api = useOrganizationApi('2fa_races');
    it.each(['verify-totp', 'verify-backup-code'])(
      'rechecks the committed policy after %s inserts a session',
      async (path) => {
        const setup = await api.setup();
        await api.ready(setup);
        const email = `member@${setup.domain}`;
        await api.signUp(email, '/workspaces');
        const user = await enrollFactor(api, await api.signIn(email));
        const challenge = await api.send('POST', '/v1/auth/sign-in/email', {
          payload: { email, password: factorPassword },
        });
        expect(challenge.json()).toMatchObject({ twoFactorRedirect: true });
        const ids = await api
          .database()
          .query<{ id: string }>('select id from app.users where email=$1', [
            email,
          ]);
        const id = ids.rows[0]?.id;
        if (id === undefined) throw new Error('Fixture person missing');
        const database = await api
          .database()
          .query<{ name: string }>('select current_database() name');
        const url = new URL(
          process.env.DATABASE_ADMIN_URL ??
            'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
        );
        const databaseName = database.rows[0]?.name;
        if (databaseName === undefined)
          throw new Error('Fixture database missing');
        url.pathname = `/${databaseName}`;
        const inspector = new Pool({
          connectionString: url.toString(),
          max: 2,
        });
        const blocker = await inspector.connect();
        let pending: ReturnType<typeof api.send> | undefined;
        try {
          // A disposable-database trigger gates the SDK insert; no application test hook.
          await inspector.query(
            `create function app.fixture_factor_pause() returns trigger language plpgsql as $$ begin if new.user_id='${id}'::uuid then perform pg_advisory_xact_lock(704282,1); end if; return new; end $$`,
          );
          await inspector.query(
            'create trigger fixture_factor_pause before insert on app.auth_sessions for each row execute function app.fixture_factor_pause()',
          );
          await blocker.query('select pg_advisory_lock(704282,1)');
          pending = Promise.resolve(
            api.send('POST', `/v1/auth/two-factor/${path}`, {
              headers: { cookie: challengeCookie(challenge) },
              payload: {
                code:
                  path === 'verify-totp'
                    ? authenticatorCode(user.totpURI)
                    : user.backupCodes[0],
              },
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
              { timeout: 10_000 },
            )
            .toBe(true);
          const owner = await inspector.query<{ id: string }>(
            'select id from app.users where email=$1',
            [setup.ownerEmail],
          );
          const actorId = owner.rows[0]?.id;
          if (actorId === undefined) throw new Error('Fixture owner missing');
          await api.identity().federation.store.configureEnforcement({
            workspaceId: setup.workspaceId,
            actorId,
            domainId: setup.domainId,
            required: true,
            expectedRevision: 4,
            idempotencyKey: randomUUID(),
          });
          await blocker.query('select pg_advisory_unlock(704282,1)');
          const reply = await pending;
          expectProblem(reply, 409, 'auth.conflict');
          expect(
            api
              .mailedMessages(email)
              .filter((message) => message.purpose === 'recovery_code_sign_in'),
          ).toHaveLength(0);
          const cookies = reply.headers['set-cookie'];
          expect(
            Array.isArray(cookies) ? cookies : [cookies ?? ''],
          ).not.toEqual(
            expect.arrayContaining([
              expect.stringMatching(/^pertexo_session=[^;]/u),
            ]),
          );
          expect(
            (
              await inspector.query(
                'select id from app.auth_sessions where user_id=$1',
                [id],
              )
            ).rows,
          ).toHaveLength(0);
        } finally {
          await blocker.query('select pg_advisory_unlock(704282,1)');
          await pending;
          await inspector.query(
            'drop trigger if exists fixture_factor_pause on app.auth_sessions',
          );
          await inspector.query(
            'drop function if exists app.fixture_factor_pause()',
          );
          blocker.release();
          await inspector.end();
        }
      },
    );
  },
);
