import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../../../src/config.js';
import { migrateDatabase } from '../../../src/migrations.js';
import {
  createWorkspaceDatabase,
  InheritedSessionContextError,
} from '../../../src/platform/index.js';
import { createDatabasePool } from '../../../src/platform/pool/telemetry/create-pool.js';
import { APP_SETTING_NAMES } from '../../../src/tenant-access/app-settings.js';
import { createDisposableDatabaseFixture } from '../../../src/testing/postgres/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const appBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const maintenanceBaseUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

const databaseName = `pertexo_test_inherited_${randomUUID().replaceAll('-', '')}`;
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  databaseName,
  ownerRole: 'pertexo_owner',
});

const urlFor = (base: string, search = '') => {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  url.search = search;
  return url.toString();
};

let admin: Pool;

beforeAll(async () => {
  await fixture.create();
  // The schema's policies and functions name the app settings to check.
  await migrateDatabase({
    connectionString: urlFor(migrationBaseUrl),
    ownerRole: 'pertexo_owner',
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
  });
  admin = new Pool({ connectionString: urlFor(adminUrl), max: 1 });
  await admin.query('create extension if not exists pg_stat_statements');
}, 60_000);

afterAll(async () => {
  await admin.end();
  await fixture.drop();
});

/** Applies a role or database default for one case, then removes it. */
async function withDefault<T>(
  target: 'database' | 'role',
  setting: string,
  value: string,
  run: () => Promise<T>,
): Promise<T> {
  const scope =
    target === 'database'
      ? `database "${databaseName}"`
      : `role pertexo_app in database "${databaseName}"`;
  await admin.query(`alter ${scope} set ${setting} = '${value}'`);
  try {
    return await run();
  } finally {
    await admin.query(`alter ${scope} reset ${setting}`);
  }
}

async function refusal(pool: Pool): Promise<unknown> {
  try {
    await pool.query('select 1');
  } catch (error: unknown) {
    return error;
  } finally {
    await pool.end();
  }
  throw new Error('expected the pool to refuse');
}

describe('a pool whose fresh connection already carries app settings', () => {
  it.each(['api', 'worker'] as const)(
    'refuses a %s pool when the role has a workspace default',
    async (role) => {
      const workspaceId = randomUUID();
      const error = await withDefault(
        'role',
        'app.workspace_id',
        workspaceId,
        () =>
          refusal(
            createDatabasePool(
              { connectionString: urlFor(appBaseUrl), max: 1 },
              { monitorLockWaits: false, role },
            ),
          ),
      );
      expect(error).toBeInstanceOf(InheritedSessionContextError);
      expect(error).toMatchObject({ role, settings: ['app.workspace_id'] });
      expect(String(error)).not.toContain(workspaceId);
    },
  );

  it('refuses a maintenance pool when the database has an organization default', async () => {
    const error = await withDefault(
      'database',
      'app.organization_id',
      randomUUID(),
      () =>
        refusal(
          createDatabasePool(
            { connectionString: urlFor(maintenanceBaseUrl), max: 1 },
            { monitorLockWaits: false, role: 'maintenance' },
          ),
        ),
    );
    expect(error).toMatchObject({
      name: 'InheritedSessionContextError',
      settings: ['app.organization_id'],
    });
  });

  it('refuses startup options in the pool config and in the connection string', async () => {
    await expect(
      refusal(
        createDatabasePool(
          {
            connectionString: urlFor(appBaseUrl),
            max: 1,
            options: `-c app.actor_id=${randomUUID()}`,
          },
          { monitorLockWaits: false, role: 'api' },
        ),
      ),
    ).resolves.toMatchObject({ settings: ['app.actor_id'] });
    await expect(
      refusal(
        createDatabasePool(
          {
            connectionString: urlFor(
              appBaseUrl,
              '?options=-c%20app.discovery_scope%3Dworkspace_memberships',
            ),
            max: 1,
          },
          { monitorLockWaits: false, role: 'worker' },
        ),
      ),
    ).resolves.toMatchObject({ settings: ['app.discovery_scope'] });
  });

  it('refuses an app setting the code never sets', async () => {
    const error = await withDefault(
      'role',
      'app.workflow_concurrency_protocol',
      '1',
      () =>
        refusal(
          createDatabasePool(
            { connectionString: urlFor(appBaseUrl), max: 1 },
            { monitorLockWaits: false, role: 'api' },
          ),
        ),
    );
    expect(error).toMatchObject({
      settings: ['app.workflow_concurrency_protocol'],
    });
  });

  it('stops the readiness check a process runs at startup', async () => {
    await withDefault('role', 'app.workspace_id', randomUUID(), async () => {
      const database = createWorkspaceDatabase(
        parseDatabaseConfig({
          connectionString: urlFor(appBaseUrl),
          ownerRole: 'pertexo_owner',
          max: 1,
        }),
      );
      try {
        await expect(database.checkReadiness()).rejects.toBeInstanceOf(
          InheritedSessionContextError,
        );
        await expect(database.checkReadiness()).rejects.toBeInstanceOf(
          InheritedSessionContextError,
        );
      } finally {
        await database.close();
      }
    });
  });
});

/**
 * Every app.* name the catalog reads, in any schema, with any name
 * PostgreSQL accepts. This scan takes relation locks, so it lives here, not
 * in the pool's boot check.
 */
const CATALOG_SCAN = `
  with source(text) as (
    select concat_ws(' ', fn.prosrc, pg_get_function_sqlbody(fn.oid))
      from pg_proc fn join pg_namespace ns on ns.oid = fn.pronamespace
     where ns.nspname not in ('pg_catalog', 'information_schema')
    union all select pg_get_viewdef(rel.oid) from pg_class rel
     where rel.relkind in ('v', 'm')
       and rel.relnamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
    union all select pg_get_expr(def.adbin, def.adrelid) from pg_attrdef def
    union all select pg_get_constraintdef(con.oid) from pg_constraint con
    union all select pg_get_expr(pol.polqual, pol.polrelid) from pg_policy pol
    union all select pg_get_expr(pol.polwithcheck, pol.polrelid) from pg_policy pol
  )
  select distinct lower((regexp_matches(
    text, 'current_setting\\s*\\(\\s*''(app\\.[A-Za-z0-9_.$]+)''', 'gi'))[1]) as name
    from source where text is not null order by 1`;

async function scannedNames(): Promise<string[]> {
  return (await admin.query<{ name: string }>(CATALOG_SCAN)).rows.map(
    (row) => row.name,
  );
}

describe('the app setting names a pool checks', () => {
  it('include every app setting the migrated catalog reads', async () => {
    const scanned = await scannedNames();
    expect(scanned).toContain('app.workspace_id');
    expect(scanned.filter((name) => !APP_SETTING_NAMES.includes(name))).toEqual(
      [],
    );
  });

  it('come from a scan that finds every kind of reader', async () => {
    await admin.query(`
      create table public.j9_readers (
        id integer,
        scope text default current_setting('app.default_reader', true),
        check (coalesce(current_setting('app.check_reader', true), '') is not null)
      );
      alter table public.j9_readers enable row level security;
      create policy j9_scope2 on public.j9_readers
        using (current_setting('app.scope2', true) is null);
      create function public.j9_outside() returns text language sql
        as $$ select current_setting ( 'app.outside_reader', true) $$;
      create function public.j9_atomic() returns text language sql
        return current_setting('APP.Upper_Reader', true);
      create view public.j9_view as
        select current_setting('app.view_reader', true) as reader;
    `);
    try {
      expect(await scannedNames()).toEqual(
        expect.arrayContaining([
          'app.check_reader',
          'app.default_reader',
          'app.outside_reader',
          'app.scope2',
          'app.upper_reader',
          'app.view_reader',
        ]),
      );
    } finally {
      await admin.query(`
        drop view public.j9_view;
        drop function public.j9_atomic();
        drop function public.j9_outside();
        drop table public.j9_readers;
      `);
    }
  });
});

describe('a pool whose fresh connection is clean', () => {
  it('inspects one connection once, however many checkouts follow', async () => {
    await admin.query('select pg_stat_statements_reset()');
    const pools = [
      createDatabasePool(
        { connectionString: urlFor(appBaseUrl), max: 2 },
        { monitorLockWaits: false, role: 'api' },
      ),
      createDatabasePool(
        { connectionString: urlFor(maintenanceBaseUrl), max: 2 },
        { monitorLockWaits: false, role: 'maintenance' },
      ),
    ];
    try {
      for (const pool of pools) {
        for (let index = 0; index < 5; index += 1)
          await expect(pool.query('select 1 as one')).resolves.toMatchObject({
            rows: [{ one: 1 }],
          });
        const client = await pool.connect();
        client.release();
      }
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
    const inspections = await admin.query<{ calls: string }>(
      `select coalesce(sum(s.calls), 0)::text calls
         from pg_stat_statements s join pg_database d on d.oid = s.dbid
        where d.datname = $1 and s.query like '%current_setting(name%'`,
      [databaseName],
    );
    expect(inspections.rows[0]?.calls).toBe('2');
  });
});
