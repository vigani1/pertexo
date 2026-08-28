import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  checkDatabaseReadiness,
  EXPECTED_MIGRATION_HEAD,
} from '../src/readiness.js';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
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
const databaseName = `pertexo_test_0070_preview_deadline_${randomUUID().replaceAll('-', '')}`;

function databaseUrl(base: string): string {
  const value = new URL(base);
  value.pathname = `/${databaseName}`;
  return value.toString();
}

const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: databaseUrl(migrationBaseUrl),
  dispatcherRole: 'pertexo_dispatcher',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  maintenanceRole: 'pertexo_maintenance',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
    );
  } finally {
    await admin.end();
  }
}, 30_000);

afterAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('preview execution deadline prior-head migration', () => {
  it('upgrades 0069 with the exact deadline schema and startup contract', async () => {
    const priorDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-0069-preview-deadline-'),
    );
    try {
      const migrations = (await readdir(MIGRATIONS_DIRECTORY)).filter(
        (name) => /^\d{4}_.+\.sql$/u.test(name) && name < '0070_',
      );
      await Promise.all(
        migrations.map((name) =>
          copyFile(
            path.join(MIGRATIONS_DIRECTORY, name),
            path.join(priorDirectory, name),
          ),
        ),
      );
      await migrateDatabase(migrationConfig, priorDirectory);

      const owner = new Pool({
        connectionString: databaseUrl(adminUrl),
        max: 1,
      });
      try {
        await expect(
          owner.query(
            `select execution_deadline_at from app.preview_runs limit 1`,
          ),
        ).rejects.toMatchObject({ code: '42703' });
      } finally {
        await owner.end();
      }

      await migrateDatabase(migrationConfig);
      const api = new Pool({
        connectionString: databaseUrl(apiBaseUrl),
        max: 1,
      });
      const ownerAfter = new Pool({
        connectionString: databaseUrl(adminUrl),
        max: 1,
      });
      try {
        await expect(
          checkDatabaseReadiness(api, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).resolves.toMatchObject({ migrationHead: EXPECTED_MIGRATION_HEAD });
        await expect(
          ownerAfter.query<{
            body_hash: string;
            constraint_definition: string;
          }>(
            `select
               md5(function.prosrc) body_hash,
               pg_get_constraintdef(constraint_record.oid) constraint_definition
             from pg_proc function
             cross join pg_constraint constraint_record
             where function.oid=to_regprocedure('app.reject_preview_run_pin_change()')
               and constraint_record.conrelid='app.preview_runs'::regclass
               and constraint_record.conname='preview_runs_execution_deadline_order'`,
          ),
        ).resolves.toMatchObject({
          rows: [
            {
              body_hash: 'e3e80198979101aabfc681553bcdbedf',
              constraint_definition:
                'CHECK (((execution_deadline_at > created_at) AND (execution_deadline_at <= expires_at)))',
            },
          ],
        });
      } finally {
        await Promise.all([api.end(), ownerAfter.end()]);
      }
    } finally {
      await rm(priorDirectory, { force: true, recursive: true });
    }
  }, 60_000);
});
