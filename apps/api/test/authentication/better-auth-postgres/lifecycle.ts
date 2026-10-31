import { migrateDatabase } from '@pertexo/database/testing';
import { Pool } from 'pg';

import {
  createBetterAuthRuntime,
  type BetterAuthRuntime,
} from '../../../src/authentication/better-auth/runtime.js';

import { adminUrl, databaseName, migrationUrl, apiUrl } from './environment.js';
import { mail } from './mail.js';

export let runtime: BetterAuthRuntime;

export async function prepareBetterAuthPostgresIntegrationTestTs() {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_app, pertexo_app`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase({
    appRole: 'pertexo_app',
    connectionString: migrationUrl,
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
  });
  runtime = createBetterAuthRuntime({
    signUpMode: 'open',
    baseUrl: 'http://pertexo.test',
    secret: 'postgres-integration-secret-with-at-least-32-characters',
    database: {
      connectionString: apiUrl,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
      max: 2,
    },
    secureCookies: false,
    sessionTtlSeconds: 3_600,
    trustedOrigins: ['http://pertexo.test'],
    mail,
  });
}

export async function closeBetterAuthPostgresIntegrationTestTs() {
  await runtime.close();
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
