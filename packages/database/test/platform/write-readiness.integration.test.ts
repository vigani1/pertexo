import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../../src/config.js';
import { createWorkspaceDatabase } from '../../src/database.js';
import { migrateDatabase } from '../../src/migrations.js';
import { createDisposableDatabaseFixture } from '../support/postgres/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const databaseName = `pertexo_test_write_${randomUUID().replaceAll('-', '')}`;
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app'],
  databaseName,
  ownerRole: 'pertexo_owner',
});

const urlFor = (base: string) => {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

// ops-07: readiness stayed green while Postgres refused every write.
describe('database readiness', () => {
  beforeAll(async () => {
    await fixture.create();
    await migrateDatabase({
      connectionString: urlFor(migrationBaseUrl),
      ownerRole: 'pertexo_owner',
      appRole: 'pertexo_app',
      maintenanceRole: 'pertexo_maintenance',
    });
  }, 60_000);
  afterAll(() => fixture.drop());

  it('passes as the application role, repeatedly and at once', async () => {
    const database = createWorkspaceDatabase(
      parseDatabaseConfig({ connectionString: urlFor(apiBaseUrl) }),
    );
    try {
      await expect(
        Promise.all([
          database.checkReadiness(),
          database.checkReadiness(),
          database.checkReadiness(),
        ]),
      ).resolves.toHaveLength(3);
      await expect(database.checkReadiness()).resolves.toMatchObject({
        role: 'pertexo_app',
      });
    } finally {
      await database.close();
    }
  });

  it('fails when the database refuses writes', async () => {
    const admin = new Pool({ connectionString: urlFor(adminUrl) });
    const database = createWorkspaceDatabase(
      parseDatabaseConfig({ connectionString: urlFor(apiBaseUrl) }),
    );
    try {
      await admin.query(
        `alter database "${databaseName}" set default_transaction_read_only = on`,
      );
      await expect(database.checkReadiness()).rejects.toThrow(/read-only/u);
    } finally {
      await admin.query(
        `alter database "${databaseName}" reset default_transaction_read_only`,
      );
      await admin.end();
      await database.close();
    }
  });
});
