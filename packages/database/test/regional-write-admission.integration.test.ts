import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../src/migrations.js';
import {
  checkDatabaseReadiness,
  checkDatabaseServingReadiness,
} from '../src/platform/readiness.js';
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

beforeEach(async () => {
  await migration.query('begin');
  try {
    await migration.query('set local role pertexo_owner');
    await migration.query(`
      update app.regional_write_admission
         set status='unavailable',replica_identity_status='missing',
             replica_session_count=0,replay_lag_millis=null,observed_at=null,
             updated_at=clock_timestamp()
       where singleton
    `);
    await migration.query('commit');
  } catch (error: unknown) {
    await migration.query('rollback').catch(() => undefined);
    throw error;
  }
});

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
  it('removes the old overload and exposes only the exact maintenance function', async () => {
    await migration.query('begin');
    try {
      await migration.query('set local role pertexo_owner');
      const result = await migration.query<{
        api_execute: boolean;
        maintenance_execute: boolean;
        new_signature: string;
        old_signature: string | null;
        owner: string;
        proconfig: string[];
        prosecdef: boolean;
      }>(`
      select
        to_regprocedure(
          'app.record_regional_replica_lag(varchar,varchar,bigint)'
        )::text old_signature,
        to_regprocedure(
          'app.record_regional_replica_lag(varchar,varchar,bigint,integer)'
        )::text new_signature,
        pg_get_userbyid(proc.proowner) owner,proc.prosecdef,proc.proconfig,
        has_function_privilege(
          'pertexo_maintenance',proc.oid,'execute'
        ) maintenance_execute,
        has_function_privilege('pertexo_api',proc.oid,'execute') api_execute
      from pg_proc proc
      where proc.oid=to_regprocedure(
        'app.record_regional_replica_lag(varchar,varchar,bigint,integer)'
      )
      `);
      expect(result.rows).toEqual([
        {
          api_execute: false,
          maintenance_execute: true,
          new_signature:
            'app.record_regional_replica_lag(character varying,character varying,bigint,integer)',
          old_signature: null,
          owner: 'pertexo_owner',
          proconfig: ['search_path=pg_catalog, app', 'row_security=on'],
          prosecdef: true,
        },
      ]);
      await migration.query('commit');
    } catch (error: unknown) {
      await migration.query('rollback').catch(() => undefined);
      throw error;
    }
  });

  it('keeps the catalog audit at startup and steady readiness bounded', async () => {
    await expect(
      checkDatabaseReadiness(api, {
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    ).resolves.toMatchObject({ role: 'pertexo_api' });

    let operationError: unknown;
    try {
      await migration.query('begin');
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
    } catch (error: unknown) {
      operationError = error;
      await migration.query('rollback').catch(() => undefined);
    }
    let restorationError: unknown;
    try {
      await migration.query('begin');
      await migration.query('set local role pertexo_owner');
      await migration.query(
        'alter function app.assert_regional_write_admission() set row_security=on',
      );
      await migration.query('commit');
    } catch (error: unknown) {
      restorationError = error;
      await migration.query('rollback').catch(() => undefined);
    }
    if (operationError !== undefined && restorationError !== undefined)
      throw new AggregateError(
        [operationError, restorationError],
        'Regional admission audit and schema restoration both failed',
      );
    if (restorationError !== undefined)
      throw restorationError instanceof Error
        ? restorationError
        : new Error('Regional admission schema restoration failed', {
            cause: restorationError,
          });
    if (operationError !== undefined)
      throw operationError instanceof Error
        ? operationError
        : new Error('Regional admission audit failed', {
            cause: operationError,
          });
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
