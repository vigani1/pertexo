import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { unlinkMethodAndRevokeSessions } from '@pertexo/core/identity';
import {
  betterAuthIntegrationEnabled,
  browserFrom,
  type Browser,
} from '../../../support/better-auth/real-api.support.js';
import { useOrganizationApi } from './fixture.js';
import { waitForBlocked } from '../../recovery/fixture.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'usable sign-in methods at removal',
  () => {
    const api = useOrganizationApi('method_removal');
    async function person() {
      const f = await api.setup();
      const email = `member@${f.domain}`;
      await api.signUp(email, '/workspaces');

      const proof = api.person(email);
      const linked = await api.finish(await api.start(f, proof));
      expect(linked.statusCode, linked.payload).toBe(302);
      const browser = await api.signIn(email);
      const {
        rows: [user],
      } = await api
        .database()
        .query<{ id: string }>('select id from app.users where email=$1', [
          email,
        ]);
      if (user === undefined) throw new Error('Method fixture user missing');
      const { rows: methods } = await api
        .database()
        .query<{ id: string; provider_id: string }>(
          'select id,provider_id from app.auth_accounts where user_id=$1 order by id',
          [user.id],
        );
      const password = methods.find(
        (method) => method.provider_id === 'credential',
      );
      if (password === undefined) throw new Error('Password missing');
      return {
        ...f,
        email,
        proof,
        browser,
        userId: user.id,
        password,
        methods,
        organizationBrowser: browserFrom(linked),
      };
    }
    const unlink = (browser: Browser, methodId: string) =>
      api.send('POST', '/v1/auth/account-security/methods/unlink', {
        browser,
        payload: { methodId },
      });
    it.each([
      'disabled',
      'removed',
      'wrong-domain',
      'unconfigured-social',
      'inactive-directory',
    ] as const)(
      'refuses to remove the password with only a %s alternative, preserving methods and session',
      async (alternative) => {
        const f = await person();
        if (alternative === 'disabled')
          await api
            .database()
            .query('update app.auth_providers set enabled=false where id=$1', [
              f.providerId,
            ]);
        if (alternative === 'removed')
          await api
            .database()
            .query('delete from app.auth_providers where id=$1', [
              f.providerId,
            ]);
        if (alternative === 'wrong-domain')
          await api
            .database()
            .query('update app.auth_domains set verified_at=null where id=$1', [
              f.domainId,
            ]);
        if (alternative === 'unconfigured-social') {
          await api
            .database()
            .query(
              "delete from app.auth_accounts where user_id=$1 and provider_id<>'credential'",
              [f.userId],
            );
          await api
            .database()
            .query(
              "insert into app.auth_accounts(id,user_id,provider_id,account_id) values($1,$2,'google',$3)",
              [randomUUID(), f.userId, randomUUID()],
            );
        }
        if (alternative === 'inactive-directory')
          await api.database().query(
            `insert into app.auth_directory_users(id,organization_id,user_name,normalized_user_name,login_email,profile,user_id,active)
           values($1,$2,$3,$3,$3,'{}',$4,false)`,
            [randomUUID(), f.settings.organization?.id, f.email, f.userId],
          );
        const before = (
          await api
            .database()
            .query(
              'select id from app.auth_accounts where user_id=$1 order by id',
              [f.userId],
            )
        ).rows;
        const response = await unlink(f.browser, f.password.id);
        expect(response.statusCode, response.payload).toBe(400);
        expect(response.json()).toMatchObject({
          code: 'auth.last_method',
          title:
            'Add another working sign-in method allowed by your organization before removing this one.',
        });
        expect(
          (
            await api
              .database()
              .query(
                'select id from app.auth_accounts where user_id=$1 order by id',
                [f.userId],
              )
          ).rows,
        ).toEqual(before);
        expect(
          (await api.send('GET', '/v1/users/me', { browser: f.browser }))
            .statusCode,
        ).toBe(200);
      },
    );
    it('removes a password when an enabled permitted organization method still works', async () => {
      const f = await person();
      const response = await unlink(f.browser, f.password.id);
      expect(response.statusCode, response.payload).toBe(200);
      expect(
        (
          await api
            .database()
            .query(
              'select provider_id from app.auth_accounts where user_id=$1',
              [f.userId],
            )
        ).rows,
      ).toEqual([{ provider_id: f.providerId }]);
      expect(
        (await api.send('GET', '/v1/users/me', { browser: f.browser }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await api.send('GET', '/v1/users/me', {
            browser: browserFrom(response),
          })
        ).statusCode,
      ).toBe(200);
    });
    it('does not count an organization protocol that this process cannot serve', async () => {
      const f = await person();
      const url = new URL(process.env.DATABASE_URL ?? '');
      url.pathname = new URL(
        api.database().options.connectionString ?? '',
      ).pathname;
      const pool = new Pool({ connectionString: url.toString(), max: 1 });
      try {
        expect(
          await unlinkMethodAndRevokeSessions(pool, {
            userId: f.userId,
            methodId: f.password.id,
            socialProviders: [],
            organizationProtocols: [],
          }),
        ).toBe('last_method');
        expect(
          (
            await api
              .database()
              .query(
                'select id,provider_id from app.auth_accounts where user_id=$1 order by id',
                [f.userId],
              )
          ).rows,
        ).toEqual(f.methods);
      } finally {
        await pool.end();
      }
    });
    it('observes a committed provider disable after waiting for the organization lock', async () => {
      const f = await person();
      const observer = new Pool({ ...api.database().options, max: 1 });
      const lock = await api.database().connect();
      let pending: ReturnType<typeof unlink> | undefined;
      try {
        await lock.query('begin');
        const {
          rows: [backend],
        } = await lock.query<{ pid: number }>('select pg_backend_pid() pid');
        if (backend === undefined) throw new Error('No backend');
        await lock.query(
          'select id from app.auth_organizations where id=$1 for update',
          [f.settings.organization?.id],
        );
        await lock.query(
          'update app.auth_providers set enabled=false where id=$1',
          [f.providerId],
        );
        pending = unlink(f.browser, f.password.id);
        await waitForBlocked(observer, backend.pid, 1);
        await lock.query('commit');
      } finally {
        await lock.query('rollback');
        lock.release();
        await observer.end();
      }
      expect((await pending).json()).toMatchObject({
        code: 'auth.last_method',
      });
      expect(
        (
          await api
            .database()
            .query('select id from app.auth_accounts where id=$1', [
              f.password.id,
            ])
        ).rows,
      ).toEqual([{ id: f.password.id }]);
    });

    it('does not count an empty password or a password blocked by required SSO', async () => {
      for (const blocked of ['empty', 'sso']) {
        const f = await person();
        const method = f.methods.find(
          (value) => value.provider_id === f.providerId,
        );
        if (method === undefined)
          throw new Error('Organization method missing');
        if (blocked === 'empty')
          await api
            .database()
            .query("update app.auth_accounts set password='' where id=$1", [
              f.password.id,
            ]);
        else {
          await api.ready(f);
          await api.enforce(f);
        }
        const current = browserFrom(
          await api.finish(await api.start(f, f.proof)),
        );
        const response = await unlink(current, method.id);
        expect(response.statusCode, response.payload).toBe(400);
        expect(response.json()).toMatchObject({ code: 'auth.last_method' });
        expect(
          (
            await api
              .database()
              .query('select id from app.auth_accounts where user_id=$1', [
                f.userId,
              ])
          ).rows,
        ).toHaveLength(2);
      }
    });
    it('preserves a recovery owner password even with a working organization method', async () => {
      const f = await api.setup(true);
      await api.ready(f);
      await api.enforce(f);
      const current = browserFrom(
        await api.finish(await api.start(f, api.person(f.ownerEmail))),
      );
      const security = await api.send('GET', '/v1/auth/account-security', {
        browser: current,
      });
      const password = security
        .json<{ methods: { id: string; kind: string }[] }>()
        .methods.find((method) => method.kind === 'password');
      if (password === undefined) throw new Error('Recovery password missing');
      const response = await unlink(current, password.id);
      expect(response.statusCode, response.payload).toBe(403);
      expect(response.json()).toMatchObject({ code: 'auth.recovery_required' });
      expect(
        (
          await api.send('GET', '/v1/users/me', {
            browser: await api.signIn(f.ownerEmail),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await api
            .database()
            .query('select id from app.auth_accounts where id=$1', [
              password.id,
            ])
        ).rows,
      ).toEqual([{ id: password.id }]);
    });
    it('concurrent removals leave a usable method and cannot deadlock', async () => {
      const f = await person();
      const replies = await Promise.all(
        f.methods.map((method) => unlink(f.browser, method.id)),
      );
      expect(replies.filter((reply) => reply.statusCode === 200)).toHaveLength(
        1,
      );
      expect(
        replies.filter((reply) => [400, 401].includes(reply.statusCode)),
      ).toHaveLength(1);
      const { rows } = await api
        .database()
        .query<{ provider_id: string }>(
          'select provider_id from app.auth_accounts where user_id=$1',
          [f.userId],
        );
      expect(rows).toHaveLength(1);
      if (rows[0]?.provider_id === 'credential') await api.signIn(f.email);
      else
        expect(
          (await api.finish(await api.start(f, f.proof))).headers.location,
        ).not.toContain('ssoError');
    });

    it.each(['policy', 'directory'] as const)(
      'observes a committed %s change after the organization lock wait',
      async (change) => {
        const f = await person();
        if (change === 'directory')
          await api
            .database()
            .query(
              `insert into app.auth_directory_users(id,organization_id,user_name,normalized_user_name,login_email,profile,user_id,active) values($1,$2,$3,$3,$3,'{}',$4,true)`,
              [randomUUID(), f.settings.organization?.id, f.email, f.userId],
            );
        const organization = f.methods.find(
          (method) => method.provider_id === f.providerId,
        );
        if (organization === undefined)
          throw new Error('Organization method missing');
        const observer = new Pool({ ...api.database().options, max: 1 });
        const lock = await api.database().connect();
        let pending: ReturnType<typeof unlink> | undefined;
        try {
          await lock.query('begin');
          const {
            rows: [backend],
          } = await lock.query<{ pid: number }>('select pg_backend_pid() pid');
          if (backend === undefined) throw new Error('Lock backend missing');
          await lock.query(
            'select id from app.auth_organizations where id=$1 for update',
            [f.settings.organization?.id],
          );
          if (change === 'policy')
            await lock.query(
              'update app.auth_domains set require_sso=true where id=$1',
              [f.domainId],
            );
          else
            await lock.query(
              'update app.auth_directory_users set active=false where user_id=$1',
              [f.userId],
            );
          pending =
            change === 'policy'
              ? unlink(f.organizationBrowser, organization.id)
              : unlink(f.browser, f.password.id);
          await waitForBlocked(observer, backend.pid, 1);
          await lock.query('commit');
        } finally {
          await lock.query('rollback');
          lock.release();
          await observer.end();
        }
        const refused = await pending;
        expect(refused.statusCode, refused.payload).toBe(400);
        expect(refused.json()).toMatchObject({ code: 'auth.last_method' });
        expect(
          (
            await api
              .database()
              .query(
                'select id,provider_id from app.auth_accounts where user_id=$1 order by id',
                [f.userId],
              )
          ).rows,
        ).toEqual(f.methods);
      },
    );
  },
);
