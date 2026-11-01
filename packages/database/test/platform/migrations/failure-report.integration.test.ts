import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrationCli } from '../../../src/migrate.js';
import { migrateDatabase } from '../../../src/migrations.js';
import { createDisposableDatabaseFixture } from '../../../src/testing/postgres/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

const BROKEN_FILE = '0000_broken_on_purpose.sql';

describe('a migration that fails', () => {
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_app', 'pertexo_migration', 'pertexo_maintenance'],
    databaseName: `pertexo_test_migration_failure_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });
  let directory: string;
  let exitCode: number;
  let errorOutput = '';

  beforeAll(async () => {
    await fixture.create();
    directory = await mkdtemp(join(tmpdir(), 'pertexo-migration-failure-'));
    await writeFile(
      join(directory, BROKEN_FILE),
      'create table definitely not valid sql;\n',
    );
    exitCode = await runMigrationCli({
      loadConfig: () => ({
        appRole: 'pertexo_app',
        connectionString: fixture.databaseUrl(migrationUrl),
        maintenanceRole: 'pertexo_maintenance',
        ownerRole: 'pertexo_owner',
      }),
      migrate: (config) => migrateDatabase(config, directory),
      writeError: (value) => {
        errorOutput += value;
      },
      writeOutput: () => undefined,
    });
  }, 60_000);

  afterAll(async () => {
    await rm(directory, { force: true, recursive: true });
    await fixture.drop();
  }, 60_000);

  it('exits with a failure', () => {
    expect(exitCode).toBe(1);
  });

  // ops-08: `database.migration_failed` carries only `errorType`, so a rollback has no reason.
  it('names the file that failed', () => {
    expect(errorOutput).toContain(BROKEN_FILE);
  });

  // ops-08: the operator needs the reason, while the app is down.
  it('states the reason', () => {
    expect(errorOutput).toContain('syntax error');
  });

  it('never prints a connection password', () => {
    expect(errorOutput).not.toContain('pertexo-local-migration');
  });
});
