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
import { createDisposableDatabaseFixture } from './disposable-database.js';

export const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
export const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const sharedDatabase = process.env.PERTEXO_Q11_SHARED_DATABASE === '1';
export const databaseName = sharedDatabase
  ? new URL(migrationBaseUrl).pathname.slice(1)
  : `pertexo_test_retention_${randomUUID().replaceAll('-', '')}`;
export const withDatabase = (baseUrl: string) => {
  const url = new URL(baseUrl);
  if (!sharedDatabase) url.pathname = `/${databaseName}`;
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
    const deadline = Date.now() + 5_000;
    do {
      const result = await monitor.query<{ blocked: boolean }>(
        `select exists (
           select 1 from pg_stat_activity
            where application_name=$1 and datname=$2
              and wait_event_type='Lock'
         ) blocked`,
        [applicationName, databaseName],
      );
      if (result.rows[0]?.blocked === true) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    } while (Date.now() < deadline);
    throw new Error(
      `PostgreSQL application ${applicationName} did not block in ${databaseName} within 5000ms`,
    );
  } finally {
    await monitor.end();
  }
}
export const migrationUrl = withDatabase(migrationBaseUrl);
export const maintenanceUrl = withDatabase(
  process.env.DATABASE_MAINTENANCE_URL ??
    'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
);
export const apiUrl = withDatabase(
  process.env.DATABASE_API_URL ??
    'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo',
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
export let retention!: ReturnType<typeof createRetentionDatabase>;
export let operator!: ReturnType<typeof createOperatorCommandDatabase>;
export let owner!: Pool;
let databaseCreated = false;
let retentionCreated = false;
let operatorCreated = false;
let ownerCreated = false;
const disposable = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: [
    'pertexo_migration',
    'pertexo_maintenance',
    'pertexo_api',
    'pertexo_worker',
    'pertexo_dispatcher',
    'pertexo_lifecycle_command',
    'pertexo_operator',
  ],
  databaseName,
  ownerRole: 'pertexo_owner',
});

beforeAll(async () => {
  try {
    if (!sharedDatabase) {
      await disposable.create();
      databaseCreated = true;
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
    }
    retention = createRetentionDatabase(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
      {
        leaseOwner: 'retention-integration',
        leaseSeconds: 60,
        maxPagesPerBatch: 10,
        pageSize: 2,
      },
    );
    retentionCreated = true;
    operator = createOperatorCommandDatabase(
      parseDatabaseConfig({ connectionString: operatorUrl, max: 1 }),
    );
    operatorCreated = true;
    owner = new Pool({ connectionString: migrationUrl, max: 1 });
    ownerCreated = true;
    await owner.query('begin');
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
    const failures: unknown[] = [error];
    if (ownerCreated) await owner.query('rollback').catch(() => undefined);
    const closed = await Promise.allSettled([
      ...(retentionCreated ? [retention.close()] : []),
      ...(operatorCreated ? [operator.close()] : []),
      ...(ownerCreated ? [owner.end()] : []),
    ]);
    for (const result of closed)
      if (result.status === 'rejected') failures.push(result.reason);
    retentionCreated = false;
    operatorCreated = false;
    ownerCreated = false;
    if (!sharedDatabase && databaseCreated) {
      try {
        await disposable.drop();
        databaseCreated = false;
      } catch (cleanupError: unknown) {
        failures.push(cleanupError);
      }
    }
    throw new AggregateError(failures, 'Retention fixture setup failed');
  }
}, 120_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const closed = await Promise.allSettled([
    ...(retentionCreated ? [retention.close()] : []),
    ...(operatorCreated ? [operator.close()] : []),
    ...(ownerCreated ? [owner.end()] : []),
  ]);
  for (const outcome of closed)
    if (outcome.status === 'rejected') failures.push(outcome.reason);
  if (!sharedDatabase && databaseCreated) {
    try {
      await disposable.drop();
      databaseCreated = false;
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'Retention fixture cleanup failed');
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
