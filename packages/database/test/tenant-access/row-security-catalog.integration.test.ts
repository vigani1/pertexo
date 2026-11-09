import { expect, it } from 'vitest';
import { withUpgradeDatabase } from '../platform/migrations/upgrade-fixture.js';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

it('isolates every catalog-discovered workspace policy and rejects malformed settings and cross-workspace writes', async () => {
  await withUpgradeDatabase(116, async ({ admin, upgrade }) => {
    const changed = (
      await admin.query<{ tablename: string }>(
        `select distinct tablename from pg_policies where schemaname='app' order by tablename`,
      )
    ).rows;
    expect(changed.length).toBeGreaterThan(100);
    console.log(`Catalog isolation matrix: ${String(changed.length)} tables`);
    const appGrants = async () =>
      (
        await admin.query<{
          table_name: string;
          column_name: string;
          privilege_type: string;
          is_grantable: string;
        }>(
          `select table_name,column_name,privilege_type,is_grantable from information_schema.column_privileges where table_schema='app' and grantee='pertexo_app' order by table_name,column_name,privilege_type`,
        )
      ).rows;
    const grantsBefore = await appGrants();
    await upgrade();
    expect(await appGrants()).toEqual(grantsBefore);
    const actualTables = (
      await admin.query<{ relname: string; relrowsecurity: boolean }>(
        `select relname,relrowsecurity from pg_class where relnamespace='app'::regnamespace and relname=any($1)`,
        [changed.map((row) => row.tablename)],
      )
    ).rows;
    expect(actualTables).toHaveLength(changed.length);
    for (const table of actualTables)
      expect(table.relrowsecurity, table.relname).toBe(true);
    const policies = (
      await admin.query<{
        tablename: string;
        policyname: string;
        cmd: string;
        qual: string | null;
        with_check: string | null;
      }>(
        `select * from pg_policies where schemaname='app' and 'pertexo_app'=any(roles)`,
      )
    ).rows;
    const client = await admin.connect();
    try {
      await client.query('create schema isolation_probe');
      await client.query(
        'grant usage on schema isolation_probe to pertexo_app',
      );
      for (const { tablename } of changed) {
        const target = `isolation_probe.${quote(tablename)}`;
        // Exercise the installed policies with populated rows independently of
        // unrelated product constraints; real stored rows are covered by the upgrade test.
        await client.query(
          `create table ${target}(id int, workspace_id uuid, user_id uuid, actor_user_id uuid, status text, job_name text, published_at timestamptz, failed_at timestamptz, batch_id uuid, prior_workspace_id uuid)`,
        );
        await client.query(`alter table ${target} enable row level security`);
        await client.query(
          `grant select,insert,update,delete on ${target} to pertexo_app`,
        );
        for (const p of policies.filter((p) => p.tablename === tablename)) {
          await client.query(
            `create policy ${quote(p.policyname)} on ${target} for ${p.cmd} to pertexo_app ${p.qual === null ? '' : `using (${p.qual})`} ${p.with_check === null ? '' : `with check (${p.with_check})`}`,
          );
        }
        await client.query(
          `insert into ${target}(id,workspace_id,prior_workspace_id) values(1,$1,$1),(2,$2,$2)`,
          [a, b],
        );
        for (const context of [undefined, '', a, 'malformed']) {
          await client.query('begin');
          await client.query('set local role pertexo_app');
          if (context !== undefined)
            await client.query(
              "select set_config('app.workspace_id',$1,true)",
              [context],
            );
          const readable = policies.some(
            (p) =>
              p.tablename === tablename && ['ALL', 'SELECT'].includes(p.cmd),
          );
          const scoped = policies.some(
            (p) =>
              p.tablename === tablename &&
              ((p.qual?.includes('app.workspace_id') ?? false) ||
                (p.with_check?.includes('app.workspace_id') ?? false)),
          );
          const read =
            context === 'malformed' && !readable && scoped
              ? client.query(
                  `insert into ${target}(id,workspace_id,prior_workspace_id) values(3,$1,$1)`,
                  [a],
                )
              : client.query(`select id from ${target} order by id`);
          if (context === 'malformed' && scoped)
            await expect(read, tablename).rejects.toMatchObject({
              code: '22P02',
            });
          else if (context === 'malformed') {
            expect(await rowsOrInvalidUuid(read), tablename).toEqual([]);
          } else
            expect((await read).rows, tablename).toEqual(
              context === a && readable && scoped ? [{ id: 1 }] : [],
            );
          await client.query('rollback');
        }
        await client.query('begin');
        await client.query('set local role pertexo_app');
        await client.query("select set_config('app.workspace_id',$1,true)", [
          a,
        ]);
        await expect(
          client.query(
            `insert into ${target}(id,workspace_id,prior_workspace_id) values(3,$1,$1)`,
            [b],
          ),
          tablename,
        ).rejects.toMatchObject({ code: '42501' });
        await client.query('rollback');
        await client.query('begin');
        await client.query('set local role pertexo_app');
        await client.query("select set_config('app.workspace_id',$1,true)", [
          a,
        ]);
        expect(
          (
            await client.query(
              `update ${target} set id=3 where workspace_id=$1 returning id`,
              [b],
            )
          ).rows,
          tablename,
        ).toEqual([]);
        await client.query('rollback');
      }
      expect(
        (
          await client.query(
            `select relname from pg_class where relnamespace='app'::regnamespace and relforcerowsecurity`,
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await client.query(
            `select policyname from pg_policies where schemaname='app' and ('pertexo_owner'=any(roles) or 'pertexo_maintenance'=any(roles))`,
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
}, 120_000);

/** A delegated policy can short-circuit before the UUID cast when no actor exists. */
async function rowsOrInvalidUuid(query: Promise<{ rows: unknown[] }>) {
  try {
    return (await query).rows;
  } catch (error) {
    expect(error).toMatchObject({ code: '22P02' });
    return [];
  }
}
