import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createWorkspaceDatabase } from '../src/database.js';
import { migrateDatabase } from '../src/migrations.js';
import {
  acquireDatabasePool,
  createDatabaseRuntime,
} from '../src/platform/database-runtime.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const databaseName = `pertexo_test_runtime_${randomUUID().replaceAll('-', '')}`;
const applicationName = `runtime-${randomUUID()}`;
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_api'],
  databaseName,
  ownerRole: 'pertexo_owner',
});

function databaseUrl(base: string, includeApplicationName = false): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  if (includeApplicationName)
    url.searchParams.set('application_name', applicationName);
  return url.toString();
}

const admin = new Pool({ connectionString: adminUrl, max: 1 });

async function sessionCount(): Promise<number> {
  const result = await admin.query<{ count: string }>(
    'select count(*) from pg_stat_activity where application_name=$1',
    [applicationName],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function waitForSessionCount(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await sessionCount()) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `database runtime retained ${String(await sessionCount())} sessions`,
  );
}

beforeAll(async () => {
  await fixture.create();
  await migrateDatabase({
    connectionString: databaseUrl(migrationBaseUrl),
    ownerRole: 'pertexo_owner',
    apiRuntimeRole: 'pertexo_api',
    workerRuntimeRole: 'pertexo_worker',
    dispatcherRole: 'pertexo_dispatcher',
    maintenanceRole: 'pertexo_maintenance',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
    operatorRole: 'pertexo_operator',
  });
}, 60_000);

afterAll(async () => {
  const failures: unknown[] = [];
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
    throw new AggregateError(
      failures,
      'Database runtime fixture cleanup failed',
    );
});

describe('database process runtime integration', () => {
  it('uses one role pool and monitor across repositories and closes both', async () => {
    const config = parseDatabaseConfig({
      connectionString: databaseUrl(apiBaseUrl, true),
      max: 5,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    });
    const runtime = createDatabaseRuntime(config, { role: 'api' });
    const lease = acquireDatabasePool(config, runtime);
    const repositories: ReturnType<typeof createWorkspaceDatabase>[] = [];
    const clients: PoolClient[] = [];

    try {
      for (let index = 0; index < 3; index += 1)
        repositories.push(createWorkspaceDatabase(config, { runtime }));
      const acquired = await Promise.all([
        lease.pool.connect(),
        lease.pool.connect(),
        lease.pool.connect(),
      ]);
      clients.push(...acquired);
      await Promise.all(
        clients.map((client, index) =>
          client.query('select pg_advisory_lock($1)', [8_100_000 + index]),
        ),
      );
      await waitForSessionCount(4);

      await Promise.all(
        clients.map((client) =>
          client.query('select pg_advisory_unlock_all()'),
        ),
      );
      for (const client of clients.splice(0)) client.release();
      await Promise.all(
        repositories.map((repository) => repository.checkCompatibility()),
      );
      await Promise.all(repositories.map((repository) => repository.close()));
      expect(await sessionCount()).toBe(4);
    } finally {
      for (const client of clients) {
        await client
          .query('select pg_advisory_unlock_all()')
          .catch(() => undefined);
        client.release(true);
      }
      await Promise.allSettled(
        repositories.map((repository) => repository.close()),
      );
      await lease.close();
      await runtime.close();
    }
    await waitForSessionCount(0);
  });
});
