import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll } from 'vitest';

import { parseDatabaseConfig } from '../../src/config.js';
import type { ControlLedger } from '../../src/lifecycle/control-ledger-coordinator.js';
import { migrateDatabase } from '../../src/migrations.js';
import { createOperatorCommandDatabase } from '../../src/operator/operator-commands.js';
import {
  createRetentionDatabase,
  createRetentionEnforcementCoordinator,
} from '../../src/lifecycle/retention.js';
import { createRunArtifactRetentionCoordinator } from '../../src/lifecycle/run-artifact-retention.js';
import { dropDisconnectedDatabase } from './disposable-database.js';

export const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
export const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
export const databaseName = `pertexo_test_retention_${randomUUID().replaceAll('-', '')}`;
export const withDatabase = (baseUrl: string) => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};
export const withApplicationName = (
  baseUrl: string,
  applicationName: string,
) => {
  const url = new URL(baseUrl);
  url.searchParams.set('application_name', applicationName);
  return url.toString();
};

export async function waitForPostgresLock(
  applicationName: string,
): Promise<void> {
  const monitor = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await monitor.query<{ blocked: boolean }>(
        `select exists (
           select 1 from pg_stat_activity
            where application_name=$1 and wait_event_type='Lock'
         ) blocked`,
        [applicationName],
      );
      if (result.rows[0]?.blocked === true) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`PostgreSQL application ${applicationName} did not block`);
  } finally {
    await monitor.end();
  }
}
export const migrationUrl = withDatabase(migrationBaseUrl);
export const maintenanceUrl = withDatabase(
  process.env.DATABASE_MAINTENANCE_URL ??
    'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
);
export const operatorUrl = withDatabase(
  process.env.DATABASE_OPERATOR_URL ??
    'postgresql://pertexo_operator:pertexo-local-operator@localhost:5432/pertexo',
);
export const workspaceId = randomUUID();
export const userId = randomUUID();
export const runIds = [
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
] as const;
export const cutoffAt = new Date('2026-08-01T00:00:00.000Z');
export const zeroHash = '0'.repeat(64);
export const retention = createRetentionDatabase(
  parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
  {
    leaseOwner: 'retention-integration',
    leaseSeconds: 60,
    maxPagesPerBatch: 10,
    pageSize: 2,
  },
);
export const operator = createOperatorCommandDatabase(
  parseDatabaseConfig({ connectionString: operatorUrl, max: 1 }),
);
export let owner: Pool;

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,
       pertexo_maintenance,pertexo_api,pertexo_worker,pertexo_dispatcher,
       pertexo_lifecycle_command,pertexo_operator`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase({
    apiRuntimeRole: 'pertexo_api',
    connectionString: migrationUrl,
    dispatcherRole: 'pertexo_dispatcher',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
    operatorRole: 'pertexo_operator',
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  });
  owner = new Pool({ connectionString: migrationUrl, max: 1 });
  await owner.query('begin');
  try {
    await owner.query('set local role pertexo_owner');
    await owner.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await owner.query(
      `insert into app.users(id,email,display_name) values($1,$2,'Retention integration')`,
      [userId, `${userId}@example.test`],
    );
    await owner.query(
      `insert into app.workspaces(id,name,slug,created_by)
       values($1,'Retention integration',$2,$3)`,
      [workspaceId, `retention-${workspaceId}`, userId],
    );
    await owner.query(
      'alter table app.workflow_runs no force row level security',
    );
    for (const [index, runId] of runIds.entries()) {
      const expiresAt = new Date(
        index === 3
          ? '2026-08-02T00:00:00.000Z'
          : `2026-07-0${String(index + 1)}T00:00:00.000Z`,
      );
      await owner.query(
        `insert into app.workflow_runs
          (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
           input_ref,input_ref_expires_at,created_at,updated_at)
         values($1,$2,$3,$4,'manual','queued',$5::jsonb,$6,
           $6::timestamptz-interval '30 days',$6::timestamptz-interval '30 days')`,
        [
          runId,
          workspaceId,
          randomUUID(),
          randomUUID(),
          JSON.stringify({ kind: 'inline', schemaVersion: 1, value: index }),
          expiresAt,
        ],
      );
    }
    await owner.query('alter table app.workflow_runs force row level security');
    await owner.query('commit');
  } catch (error: unknown) {
    await owner.query('rollback').catch(() => undefined);
    throw error;
  }
}, 120_000);

afterAll(async () => {
  await retention.close();
  await operator.close();
  await owner.end();
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

export {
  Pool,
  createRetentionDatabase,
  createRetentionEnforcementCoordinator,
  createRunArtifactRetentionCoordinator,
  parseDatabaseConfig,
  randomUUID,
};
export type { ControlLedger };
