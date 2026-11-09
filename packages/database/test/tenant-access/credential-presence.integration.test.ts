import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { withUpgradeDatabase } from '../platform/migrations/upgrade-fixture.js';

it('exposes only exact credential presence to maintenance and preserves credential hash isolation', async () => {
  await withUpgradeDatabase(117, async ({ admin, upgrade }) => {
    const cases = [
      { provider: 'credential', passwords: ['stored-test-hash'], count: 1 },
      { provider: 'credential', passwords: [null], count: 0 },
      { provider: 'credential', passwords: [''], count: 0 },
      { provider: 'organization-provider', passwords: [null], count: 0 },
      { provider: 'credential', passwords: [], count: 0 },
      { provider: 'credential', passwords: ['hash', null], count: 1 },
      { provider: 'credential', passwords: ['hash-one', 'hash-two'], count: 2 },
    ];
    const users: string[] = [];
    for (const entry of cases) {
      const userId = randomUUID();
      users.push(userId);
      await admin.query(
        "insert into app.users(id,email,display_name) values($1,$2,'Presence test')",
        [userId, `${userId}@example.test`],
      );
      // Nullable and empty credential records are legal stored states; provider alone is insufficient.
      for (const password of entry.passwords) {
        await admin.query(
          'insert into app.auth_accounts(id,user_id,account_id,provider_id,password) values($1,$2,$3,$4,$5)',
          [randomUUID(), userId, randomUUID(), entry.provider, password],
        );
      }
    }
    await upgrade();
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_maintenance');
      for (const [index, entry] of cases.entries()) {
        expect(
          (
            await client.query<{ count: number }>(
              'select app.password_credential_count($1::uuid) count',
              [users[index]],
            )
          ).rows,
        ).toEqual([{ count: entry.count }]);
      }
      expect(
        (
          await client.query<{ count: number }>(
            'select app.password_credential_count($1::uuid) count',
            [randomUUID()],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      await client.query('rollback');
      for (const [role, query] of [
        ['pertexo_maintenance', 'select password from app.auth_accounts'],
        [
          'pertexo_app',
          `select app.password_credential_count('${randomUUID()}')`,
        ],
      ] as const) {
        await client.query('begin');
        await client.query(`set local role ${role}`);
        await expect(client.query(query)).rejects.toMatchObject({
          code: '42501',
        });
        await client.query('rollback');
      }
      const metadata = await admin.query<{
        owner: string;
        prosecdef: boolean;
        proconfig: string[];
        result: string;
        public_execute: boolean;
      }>(
        `select pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,pg_get_function_result(p.oid) result,exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') public_execute from pg_proc p where p.oid='app.password_credential_count(uuid)'::regprocedure`,
      );
      expect(metadata.rows).toEqual([
        {
          owner: 'pertexo_owner',
          prosecdef: true,
          proconfig: ['search_path=pg_catalog'],
          result: 'integer',
          public_execute: false,
        },
      ]);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
}, 120_000);
