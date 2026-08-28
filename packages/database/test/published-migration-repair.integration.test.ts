import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const databaseName = `pertexo_test_migration_repair_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = (() => {
  const url = new URL(migrationBaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
})();
const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: databaseUrl,
  dispatcherRole: 'pertexo_dispatcher',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  maintenanceRole: 'pertexo_maintenance',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;
let priorDirectory = '';

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to
       pertexo_migration,pertexo_api,pertexo_worker,pertexo_dispatcher,
       pertexo_maintenance,pertexo_lifecycle_command,pertexo_operator`,
    );
  } finally {
    await admin.end();
  }
  priorDirectory = await mkdtemp('/tmp/pertexo-migration-repair-');
  for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
    if (/^\d{4}_.+\.sql$/u.test(name) && name < '0067_') {
      await copyFile(
        path.join(MIGRATIONS_DIRECTORY, name),
        path.join(priorDirectory, name),
      );
    }
  }
  await migrateDatabase(migrationConfig, priorDirectory);
}, 120_000);

afterAll(async () => {
  if (priorDirectory !== '') await rm(priorDirectory, { recursive: true });
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('published migration repair upgrade', () => {
  it('accepts published checksums and converges missing corrections', async () => {
    const owner = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query(`
        drop function app.lock_failure_notification_dispatch_destination(uuid,uuid,integer);
        drop table app.workflow_run_active_admissions cascade;
        drop function if exists app.workflow_run_active_capacity_available(uuid,integer,uuid);
        drop function if exists app.workflow_run_active_admission_eligible(uuid,uuid,uuid);
        drop function if exists app.reserve_workflow_run_active_admission(uuid,uuid,uuid);
        drop function if exists app.release_workflow_run_active_admission(uuid,uuid);
        drop function if exists app.release_dispatcher_workflow_run_active_admission(uuid,uuid);
        drop function if exists app.arm_dispatcher_workflow_run_active_admission(uuid,uuid);
        drop function if exists app.recover_due_workflow_run_active_admissions(integer);
        update pertexo_internal.schema_migrations
           set checksum='9f76e5fefc3914a808cb000f796760e17902876a4418d006bb82674d7778eede'
         where name='0037_failure_notification_destinations.sql';
        update pertexo_internal.schema_migrations
           set checksum='89117c0311337b655503557f7a66f63c04aa9eb6736be6ddfc4b02dea4eedf95'
         where name='0038_execution_admission.sql';
      `);
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await owner.end();
    }

    await expect(migrateDatabase(migrationConfig)).resolves.toEqual([
      '0067_reconcile_published_migration_repairs.sql',
      '0068_restore_artifact_inventory.sql',
    ]);
    await expect(migrateDatabase(migrationConfig)).resolves.toEqual([]);

    const verification = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await verification.query('set role pertexo_owner');
      const result = await verification.query<{
        active_admissions: string | null;
        active_capacity: string | null;
        destination_lock: string | null;
        recovery_type: string;
      }>(`
        select
          to_regclass('app.workflow_run_active_admissions')::text active_admissions,
          to_regprocedure('app.workflow_run_active_capacity_available(uuid,integer,uuid)')::text active_capacity,
          to_regprocedure('app.lock_failure_notification_dispatch_destination(uuid,uuid,integer)')::text destination_lock,
          format_type(attribute.atttypid,attribute.atttypmod) recovery_type
        from pg_attribute attribute
        where attribute.attrelid=to_regclass('app.workflow_run_active_admissions')
          and attribute.attname='recovery_count'
      `);
      expect(result.rows[0]).toEqual({
        active_admissions: 'app.workflow_run_active_admissions',
        active_capacity:
          'app.workflow_run_active_capacity_available(uuid,integer,uuid)',
        destination_lock:
          'app.lock_failure_notification_dispatch_destination(uuid,uuid,integer)',
        recovery_type: 'bigint',
      });
    } finally {
      await verification.end();
    }
  }, 120_000);
});
