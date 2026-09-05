import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createWorkspaceDatabase } from '../src/database.js';
import { migrateDatabase } from '../src/migrations.js';
import { createDatabaseRuntime } from '../src/platform/database-runtime.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';

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
  await admin.query(`drop database if exists "${databaseName}" with (force)`);
  await admin.query(`create database "${databaseName}" owner pertexo_owner`);
  await admin.query(`revoke all on database "${databaseName}" from public`);
  await admin.query(
    `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api`,
  );
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
  await dropDisconnectedDatabase(admin, databaseName);
  await admin.end();
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
    const repositories = [
      createWorkspaceDatabase(config, { runtime }),
      createWorkspaceDatabase(config, { runtime }),
      createWorkspaceDatabase(config, { runtime }),
    ];

    try {
      await Promise.all(
        repositories.map((repository) => repository.checkCompatibility()),
      );
      await waitForSessionCount(4);

      await Promise.all(repositories.map((repository) => repository.close()));
      expect(await sessionCount()).toBe(4);
    } finally {
      await runtime.close();
    }
    await waitForSessionCount(0);
  });
});
