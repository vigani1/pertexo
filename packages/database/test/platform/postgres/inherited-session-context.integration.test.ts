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
