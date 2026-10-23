import { randomUUID } from 'node:crypto';

import { migrateDatabase } from '@pertexo/database/testing';

import { Pool } from 'pg';

const databaseName = `pertexo_test_auth_delivery_${randomUUID().replaceAll('-', '')}`;

export const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

export const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

export const workerBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

export function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export const storeConfig = (connectionString: string) => ({
  connectionString,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
  max: 1,
  ownerRole: 'pertexo_owner',
});

export async function prepareDeliveryIntegrationTestTsFixture() {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_app, pertexo_maintenance`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase({
    appRole: 'pertexo_app',
    connectionString: databaseUrl(migrationBaseUrl),
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
  });
}

export async function closeDeliveryIntegrationTestTsFixture() {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid <> pg_backend_pid()`,
      [databaseName],
    );
    await admin.query(`drop database if exists "${databaseName}"`);
  } finally {
    await admin.end();
  }
}
