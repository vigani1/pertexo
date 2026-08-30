import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../src/migrations.js';
import {
  checkDatabaseReadiness,
  checkDatabaseServingReadiness,
} from '../src/readiness.js';
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
const maintenanceBaseUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

const databaseName = `pertexo_test_regional_fence_${randomUUID().replaceAll('-', '')}`;

function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const api = new Pool({ connectionString: databaseUrl(apiBaseUrl), max: 1 });
const maintenance = new Pool({
  connectionString: databaseUrl(maintenanceBaseUrl),
  max: 1,
});
const migration = new Pool({
  connectionString: databaseUrl(migrationBaseUrl),
  max: 1,
});

async function assertPaused(): Promise<void> {
  await expect(
    api.query('select app.assert_regional_write_admission()'),
  ).rejects.toMatchObject({ code: 'PTA03' });
}

async function readReplicaIdentity(): Promise<{
  readonly replica_identity_status: string;
  readonly replica_session_count: number;
}> {
  await migration.query('begin');
  try {
    await migration.query('set local role pertexo_owner');
    const result = await migration.query<{
      replica_identity_status: string;
      replica_session_count: number;
    }>(
      'select replica_identity_status, replica_session_count from app.regional_write_admission where singleton',
    );
    await migration.query('commit');
    const row = result.rows[0];
    if (row === undefined) throw new Error('regional admission row missing');
    return row;
  } catch (error: unknown) {
    await migration.query('rollback').catch(() => undefined);
    throw error;
  }
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher, pertexo_maintenance, pertexo_lifecycle_command, pertexo_operator`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase({
    connectionString: databaseUrl(migrationBaseUrl),
    ownerRole: 'pertexo_owner',
    apiRuntimeRole: 'pertexo_api',
    workerRuntimeRole: 'pertexo_worker',
    dispatcherRole: 'pertexo_dispatcher',
    maintenanceRole: 'pertexo_maintenance',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
    operatorRole: 'pertexo_operator',
    regionalWriteAdmissionEnforced: true,
  });
}, 60_000);

afterAll(async () => {
  await Promise.all([api.end(), maintenance.end(), migration.end()]);
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('regional write admission fence', () => {
  it('keeps the catalog audit at startup and steady readiness bounded', async () => {
    await expect(
      checkDatabaseReadiness(api, {
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    ).resolves.toMatchObject({ role: 'pertexo_api' });

    await migration.query('begin');
    try {
      await migration.query('set local role pertexo_owner');
      await migration.query(
        'alter function app.assert_regional_write_admission() set row_security=off',
      );
      await migration.query('commit');
      await expect(checkDatabaseServingReadiness(api)).resolves.toMatchObject({
        role: 'pertexo_api',
      });
      await expect(checkDatabaseReadiness(api)).rejects.toThrow(
        'Regional write admission persistence is incompatible',
      );
    } finally {
      await migration.query('rollback').catch(() => undefined);
      await migration.query('begin').catch(() => undefined);
      await migration
        .query('set local role pertexo_owner')
        .catch(() => undefined);
      await migration
        .query(
          'alter function app.assert_regional_write_admission() set row_security=on',
        )
        .catch(() => undefined);
      await migration.query('commit').catch(() => undefined);
    }
  });

  it('starts unavailable and opens only below the five-minute bound', async () => {
    await assertPaused();

    await expect(
      maintenance.query(
        "select app.record_regional_replica_lag('pertexo-eu-west-1','streaming',299999,1)",
      ),
    ).resolves.toMatchObject({
      rows: [{ record_regional_replica_lag: 'open' }],
    });
    await expect(
      api.query('select app.assert_regional_write_admission()'),
    ).resolves.toBeDefined();

    await expect(
      maintenance.query(
        "select app.record_regional_replica_lag('pertexo-eu-west-1','streaming',300000,1)",
      ),
    ).resolves.toMatchObject({
      rows: [{ record_regional_replica_lag: 'paused' }],
    });
    await assertPaused();
  });

  it('fails closed for missing, stale, and unexpected replica evidence', async () => {
    await expect(
      maintenance.query(
        "select app.record_regional_replica_lag('wrong-replica','streaming',0,1)",
      ),
    ).rejects.toThrow('unexpected regional replica identity');

    await maintenance.query(
      "select app.record_regional_replica_lag('pertexo-eu-west-1','catchup',null,1)",
    );
    await assertPaused();

    await maintenance.query(
      "select app.record_regional_replica_lag('pertexo-eu-west-1','streaming',0,1)",
    );
    await migration.query('begin');
    try {
      await migration.query('set local role pertexo_owner');
      await migration.query(
        "update app.regional_write_admission set observed_at=now()-interval '16 seconds' where singleton",
      );
      await migration.query('commit');
    } catch (error: unknown) {
      await migration.query('rollback');
      throw error;
    }
    await assertPaused();
  });

  it('fails closed and records missing, duplicate, and replacement identities', async () => {
    await expect(
      maintenance.query(
        "select app.record_regional_replica_lag('pertexo-eu-west-1','unavailable',null,0)",
      ),
    ).resolves.toMatchObject({
      rows: [{ record_regional_replica_lag: 'unavailable' }],
    });
    await expect(readReplicaIdentity()).resolves.toEqual({
      replica_identity_status: 'missing',
      replica_session_count: 0,
    });
    await assertPaused();

    await expect(
      maintenance.query(
        "select app.record_regional_replica_lag('pertexo-eu-west-1','unavailable',null,2)",
      ),
    ).resolves.toMatchObject({
      rows: [{ record_regional_replica_lag: 'unavailable' }],
    });
    await expect(readReplicaIdentity()).resolves.toEqual({
      replica_identity_status: 'duplicate',
      replica_session_count: 2,
    });
    await assertPaused();

    await expect(
      maintenance.query(
        "select app.record_regional_replica_lag('pertexo-eu-west-1','streaming',0,1)",
      ),
    ).resolves.toMatchObject({
      rows: [{ record_regional_replica_lag: 'open' }],
    });
    await expect(readReplicaIdentity()).resolves.toEqual({
      replica_identity_status: 'unique',
      replica_session_count: 1,
    });
  });
});
