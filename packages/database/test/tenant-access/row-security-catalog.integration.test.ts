import type { Pool } from 'pg';
import { expect, it } from 'vitest';
import { withDatabase } from '../platform/migrations/upgrade-fixture.js';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

// These tables remain default-deny for app, even with a valid workspace context.
const maintenanceOnlyTables = {
  webhook_endpoint_ingress_limits:
    'Maintenance-only ingress counters; the app has no direct table privileges.',
  workflow_trigger_failures:
    'Maintenance-only trigger outcome storage; direct app privileges are intentionally absent.',
} as const;

it('isolates every catalog-discovered workspace policy and rejects malformed settings and cross-workspace writes', async () => {
  await withDatabase(async ({ admin }) => {
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

    // Discover columns after upgrading, including tables added by future migrations.
    // Retain all other RLS tables too, so actor/prior-workspace policies stay covered.
    const changed = (
      await admin.query<{ tablename: string }>(`
      select c.relname tablename from pg_class c
      where c.relnamespace='app'::regnamespace and c.relkind in ('r','p','f')
        and (c.relrowsecurity or exists (
          select 1 from pg_attribute a where a.attrelid=c.oid
            and a.attname='workspace_id' and a.attnum>0 and not a.attisdropped
        )) order by c.relname
    `)
    ).rows;
    expect(changed.length).toBeGreaterThan(100);
    console.log(`Catalog isolation matrix: ${String(changed.length)} tables`);
    expect(await appGrants()).toEqual(grantsBefore);
    const policies = (
      await admin.query<{
        tablename: string;
        policyname: string;
        cmd: string;
        qual: string | null;
        with_check: string | null;
      }>(
        `select * from pg_policies where schemaname='app' and ('pertexo_app'=any(roles) or 'public'=any(roles))`,
      )
    ).rows;
    await assertCatalogCoverage(admin, changed, policies);
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
          `create table ${target}(id int, organization_id uuid, workspace_id uuid, user_id uuid, actor_user_id uuid, status text, job_name text, published_at timestamptz, failed_at timestamptz, batch_id uuid, prior_workspace_id uuid)`,
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
          const rejectsMalformed = ![
            'auth_organization_workspaces',
            'auth_directory_group_mappings',
          ].includes(tablename);
          if (context === 'malformed' && scoped && rejectsMalformed)
            await expect(read, tablename).rejects.toMatchObject({
              code: '22P02',
            });
          else if (context === 'malformed' && !rejectsMalformed) {
            expect((await read).rows, tablename).toEqual([]);
          } else if (context === 'malformed') {
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
        expect(
          (
            await client.query(
              `delete from ${target} where workspace_id=$1 returning id`,
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

/** Maintenance-only rows remain covered by default-deny and an explicit privilege check. */
async function assertCatalogCoverage(
  admin: Pool,
  changed: readonly { tablename: string }[],
  policies: readonly { tablename: string }[],
): Promise<void> {
  const actualTables = (
    await admin.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname,relrowsecurity from pg_class where relnamespace='app'::regnamespace and relname=any($1)`,
      [changed.map((row) => row.tablename)],
    )
  ).rows;
  expect(actualTables).toHaveLength(changed.length);
  for (const table of actualTables)
    expect(table.relrowsecurity, table.relname).toBe(true);
  for (const { tablename } of changed)
    expect(
      policies.some((p) => p.tablename === tablename) ||
        Object.hasOwn(maintenanceOnlyTables, tablename),
      tablename,
    ).toBe(true);
  for (const [tablename, reason] of Object.entries(maintenanceOnlyTables)) {
    expect(reason.length).toBeGreaterThan(0);
    expect(
      changed.some((table) => table.tablename === tablename),
      tablename,
    ).toBe(true);
    const access = await admin.query<{ allowed: boolean }>(
      "select has_any_column_privilege('pertexo_app',$1::text,'SELECT,INSERT,UPDATE') or has_table_privilege('pertexo_app',$1::text,'DELETE') allowed",
      [`app.${tablename}`],
    );
    expect(access.rows, tablename).toEqual([{ allowed: false }]);
  }
}

/** A delegated policy can short-circuit before the UUID cast when no actor exists. */
async function rowsOrInvalidUuid(query: Promise<{ rows: unknown[] }>) {
  try {
    return (await query).rows;
  } catch (error) {
    expect(error).toMatchObject({ code: '22P02' });
    return [];
  }
}
