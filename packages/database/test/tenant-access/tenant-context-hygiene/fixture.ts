import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { migrateDatabase } from '../../../src/migrations.js';
import { createDisposableDatabaseFixture } from '../../../src/testing/postgres/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

const databaseName = `pertexo_test_tenant_hygiene_${randomUUID().replaceAll('-', '')}`;

const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  databaseName,
  ownerRole: 'pertexo_owner',
});

function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export const apiPool = new Pool({
  connectionString: databaseUrl(apiBaseUrl),
  max: 1,
});

const admin = new Pool({ connectionString: adminUrl, max: 1 });

export async function backendId(client: Pick<Pool, 'query'>): Promise<number> {
  const result = await client.query<{ pid: number }>(
    'select pg_backend_pid() pid',
  );
  const pid = result.rows[0]?.pid;
  if (pid === undefined)
    throw new Error('PostgreSQL backend identity is absent');
  return pid;
}

export async function waitForBackendAbsent(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    const result = await admin.query<{ present: boolean }>(
      `select exists(select 1 from pg_stat_activity
        where datname=$1 and pid=$2) present`,
      [databaseName, pid],
    );
    if (result.rows[0]?.present === false) return;
    await admin.query('select pg_sleep(0.02)');
  } while (Date.now() < deadline);
  throw new Error(`PostgreSQL backend ${String(pid)} did not disconnect`);
}

export async function waitForSlowQuery(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    const result = await admin.query<{ entered: boolean }>(
      `select exists(select 1 from pg_stat_activity
        where datname=$1 and pid=$2 and state='active'
          and query like '%pg_sleep(5)%') entered`,
      [databaseName, pid],
    );
    if (result.rows[0]?.entered === true) return;
    await admin.query('select pg_sleep(0.02)');
  } while (Date.now() < deadline);
  throw new Error(`PostgreSQL backend ${String(pid)} did not enter slow query`);
}

export async function currentSettings(
  client: Pick<Pool, 'query'>,
): Promise<{ workspaceId: string | null; actorId: string | null }> {
  const result = await client.query<{
    workspace_id: string | null;
    actor_id: string | null;
  }>(
    "select current_setting('app.workspace_id', true) as workspace_id, current_setting('app.actor_id', true) as actor_id",
  );
  // The hygiene contract treats missing and empty as equally clean.
  const clean = (value: string | null | undefined): string | null =>
    value === undefined || value === null || value === '' ? null : value;
  return {
    workspaceId: clean(result.rows[0]?.workspace_id),
    actorId: clean(result.rows[0]?.actor_id),
  };
}

export async function captureRejection(
  run: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the transaction to reject');
}

export async function beforeAllFixture1() {
  await fixture.create();
  await migrateDatabase({
    connectionString: databaseUrl(migrationBaseUrl),
    ownerRole: 'pertexo_owner',
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
  });
}

export async function afterAllFixture2() {
  const failures: unknown[] = [];
  try {
    await apiPool.end();
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    await fixture.drop();
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    await admin.end();
  } catch (error: unknown) {
    failures.push(error);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'Tenant hygiene fixture cleanup failed');
}
