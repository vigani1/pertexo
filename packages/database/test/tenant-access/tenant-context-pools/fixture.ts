import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';

import { migrateDatabase } from '../../../src/migrations.js';
import { createDatabasePool } from '../../../src/platform/pool/telemetry/create-pool.js';
import type { DatabasePoolRole } from '../../../src/platform/pool/policy.js';
import { createDisposableDatabaseFixture } from '../../../src/testing/postgres/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const appUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const maintenanceUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

export const databaseName = `pertexo_test_context_pools_${randomUUID().replaceAll('-', '')}`;

const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: [
    new URL(adminUrl).username,
    'pertexo_migration',
    'pertexo_app',
    'pertexo_maintenance',
  ],
  databaseName,
  ownerRole: 'pertexo_owner',
});

/** A superuser in the disposable database, for seeding and for interfering with backends. */
export const admin = new Pool({
  connectionString: fixture.databaseUrl(adminUrl),
  max: 2,
});

/** The production pool each role uses, with the role's own deadline defaults. */
export const POOL_ROLES = [
  { role: 'api', url: appUrl, defaultTimeoutMillis: 30_000 },
  { role: 'worker', url: appUrl, defaultTimeoutMillis: 120_000 },
  { role: 'maintenance', url: maintenanceUrl, defaultTimeoutMillis: 300_000 },
] as const satisfies readonly Readonly<{
  role: DatabasePoolRole;
  url: string;
  defaultTimeoutMillis: number;
}>[];

const pools: Pool[] = [];

export function productionPool(
  role: DatabasePoolRole,
  url: string,
  max: number,
): Pool {
  const pool = createDatabasePool(
    { connectionString: fixture.databaseUrl(url), max },
    { role, monitorLockWaits: false },
  );
  pools.push(pool);
  return pool;
}

export async function backendId(client: Pick<PoolClient, 'query'>) {
  const result = await client.query<{ pid: number }>(
    'select pg_backend_pid() pid',
  );
  const pid = result.rows[0]?.pid;
  if (pid === undefined) throw new Error('backend identity is absent');
  return pid;
}

/** Every context setting as a transaction sees it; unset and empty both read as null. */
export async function contextSettings(client: Pick<PoolClient, 'query'>) {
  const result = await client.query<{
    workspace_id: string | null;
    actor_id: string | null;
    discovery_scope: string | null;
    organization_id: string | null;
    statement_timeout_millis: string;
  }>(
    `select nullif(current_setting('app.workspace_id', true), '') workspace_id,
            nullif(current_setting('app.actor_id', true), '') actor_id,
            nullif(current_setting('app.discovery_scope', true), '') discovery_scope,
            nullif(current_setting('app.organization_id', true), '') organization_id,
            (extract(epoch from current_setting('statement_timeout')::interval)*1000)::bigint
              statement_timeout_millis`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('settings are absent');
  return {
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    discoveryScope: row.discovery_scope,
    organizationId: row.organization_id,
    statementTimeoutMillis: Number(row.statement_timeout_millis),
  };
}

/** Waits until a backend is running a statement containing the marker. */
export async function waitForStatement(
  pid: number,
  marker: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await admin.query<{ running: boolean }>(
      `select exists(select 1 from pg_stat_activity
        where pid=$1 and state='active' and position($2 in query) > 0) running`,
      [pid, marker],
    );
    if (result.rows[0]?.running === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`backend ${String(pid)} never ran ${marker}`);
}

export async function seedWorkspaces(count: number): Promise<string[]> {
  const userId = randomUUID();
  await admin.query(
    "insert into app.users(id,email,display_name) values($1,$2,'Pool fixture')",
    [userId, `${userId}@pools.test`],
  );
  const workspaces: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const workspaceId = randomUUID();
    await admin.query(
      "insert into app.workspaces(id,name,slug,created_by) values($1,'Pool fixture',$2,$3)",
      [workspaceId, `pools-${workspaceId}`, userId],
    );
    workspaces.push(workspaceId);
  }
  return workspaces;
}

export async function setUpDatabase(): Promise<void> {
  await fixture.create();
  await migrateDatabase({
    connectionString: fixture.databaseUrl(migrationUrl),
    ownerRole: 'pertexo_owner',
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
  });
  // A constraint checked only at COMMIT, so a transaction can fail there.
  await admin.query(`create schema commit_probe;
    create table commit_probe.deferred_unique(
      id int, constraint deferred_unique_id unique (id) deferrable initially deferred);
    grant usage on schema commit_probe to pertexo_app, pertexo_maintenance;
    grant insert on commit_probe.deferred_unique to pertexo_app, pertexo_maintenance`);
}

export async function tearDownDatabase(): Promise<void> {
  const failures: unknown[] = [];
  for (const pool of [...pools, admin])
    await pool.end().catch((error: unknown) => failures.push(error));
  await fixture.drop().catch((error: unknown) => failures.push(error));
  if (failures.length > 0)
    throw new AggregateError(failures, 'Pool fixture cleanup failed');
}

export async function captureRejection(
  run: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected a rejection');
}
