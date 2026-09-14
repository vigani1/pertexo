import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../src/migrations.js';
import { checkDatabaseReadiness } from '../src/platform/readiness.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerBaseUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const dispatcherBaseUrl =
  process.env.DATABASE_DISPATCHER_URL ??
  'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo';

const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';
const apiRole = process.env.POSTGRES_API_RUNTIME_USER ?? 'pertexo_api';
const workerRole = process.env.POSTGRES_WORKER_RUNTIME_USER ?? 'pertexo_worker';
const dispatcherRole =
  process.env.POSTGRES_DISPATCHER_RUNTIME_USER ?? 'pertexo_dispatcher';
const maintenanceRole =
  process.env.POSTGRES_MAINTENANCE_USER ?? 'pertexo_maintenance';
const lifecycleCommandRole =
  process.env.POSTGRES_LIFECYCLE_COMMAND_USER ?? 'pertexo_lifecycle_command';
const operatorRole = process.env.POSTGRES_OPERATOR_USER ?? 'pertexo_operator';
const capacityReadinessError =
  'Artifact capacity schema, row-level security, or runtime grants are incompatible';
const databaseName = `pertexo_test_capacity_${randomUUID().replaceAll('-', '')}`;
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: [
    new URL(migrationBaseUrl).username,
    apiRole,
    workerRole,
    dispatcherRole,
  ],
  databaseName,
  ownerRole,
});
const migrationUrl = fixture.databaseUrl(migrationBaseUrl);
const apiUrl = fixture.databaseUrl(apiBaseUrl);
const workerUrl = fixture.databaseUrl(workerBaseUrl);
const dispatcherUrl = fixture.databaseUrl(dispatcherBaseUrl);

const migrationConfig = {
  apiRuntimeRole: apiRole,
  connectionString: migrationUrl,
  dispatcherRole,
  maintenanceRole,
  lifecycleCommandRole,
  operatorRole,
  ownerRole,
  workerRuntimeRole: workerRole,
} as const;

const ownerPool = new Pool({ connectionString: migrationUrl, max: 1 });
const apiPool = new Pool({ connectionString: apiUrl, max: 1 });
const workerPool = new Pool({ connectionString: workerUrl, max: 1 });
const dispatcherPool = new Pool({ connectionString: dispatcherUrl, max: 1 });

async function executeAsOwner(statement: string): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role "${ownerRole.replaceAll('"', '""')}"`);
    await client.query(statement);
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await fixture.create();
  await migrateDatabase(migrationConfig);
}, 60_000);

afterAll(async () => {
  const failures: unknown[] = [];
  for (const owner of [ownerPool, apiPool, workerPool, dispatcherPool])
    try {
      await owner.end();
    } catch (error: unknown) {
      failures.push(error);
    }
  try {
    await fixture.drop();
  } catch (error: unknown) {
    failures.push(error);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'Capacity readiness cleanup failed');
});

const readinessOptions = Object.freeze({
  apiRuntimeRole: apiRole,
  ownerRole,
  workerRuntimeRole: workerRole,
});

describe('artifact capacity readiness', () => {
  it('accepts the deployed table contract for every serving role', async () => {
    await expect(
      checkDatabaseReadiness(apiPool, readinessOptions),
    ).resolves.toMatchObject({
      role: apiRole,
    });
    await expect(
      checkDatabaseReadiness(workerPool, readinessOptions),
    ).resolves.toMatchObject({
      role: workerRole,
    });
    await expect(
      checkDatabaseReadiness(dispatcherPool, readinessOptions),
    ).resolves.toMatchObject({ role: dispatcherRole });
  });

  it('fails closed for capacity RLS, policy, function, and trigger drift', async () => {
    await executeAsOwner(
      'alter table app.workspace_artifact_capacity no force row level security',
    );
    try {
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).rejects.toThrow(capacityReadinessError);
    } finally {
      await executeAsOwner(
        'alter table app.workspace_artifact_capacity force row level security',
      );
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).resolves.toMatchObject({
        role: apiRole,
      });
    }

    await executeAsOwner(`
      alter policy workspace_artifact_capacity_workspace_scope
        on app.workspace_artifact_capacity
      using (true) with check (true)`);
    try {
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).rejects.toThrow(capacityReadinessError);
    } finally {
      await executeAsOwner(`
        alter policy workspace_artifact_capacity_workspace_scope
          on app.workspace_artifact_capacity
        using (
          workspace_id::text = nullif(current_setting('app.workspace_id', true), '')
        ) with check (
          workspace_id::text = nullif(current_setting('app.workspace_id', true), '')
        )`);
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).resolves.toMatchObject({
        role: apiRole,
      });
    }

    await executeAsOwner(
      'alter function app.artifact_capacity_transition() set search_path = pg_catalog, app',
    );
    try {
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).rejects.toThrow(capacityReadinessError);
    } finally {
      await executeAsOwner(
        'alter function app.artifact_capacity_transition() set search_path = pg_catalog, app, pg_temp',
      );
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).resolves.toMatchObject({
        role: apiRole,
      });
    }

    await executeAsOwner(
      'alter table app.artifacts disable trigger artifacts_capacity_transition',
    );
    try {
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).rejects.toThrow(capacityReadinessError);
    } finally {
      await executeAsOwner(
        'alter table app.artifacts enable trigger artifacts_capacity_transition',
      );
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).resolves.toMatchObject({
        role: apiRole,
      });
    }
  });

  it('fails closed for capacity column, default, and check-constraint drift', async () => {
    await executeAsOwner(
      'alter table app.workspace_artifact_capacity rename column charged_count to charged_count_drift',
    );
    try {
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).rejects.toThrow(capacityReadinessError);
    } finally {
      await executeAsOwner(
        'alter table app.workspace_artifact_capacity rename column charged_count_drift to charged_count',
      );
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).resolves.toMatchObject({
        role: apiRole,
      });
    }

    await executeAsOwner(
      'alter table app.workspace_artifact_capacity alter column byte_limit set default 0',
    );
    try {
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).rejects.toThrow(capacityReadinessError);
    } finally {
      await executeAsOwner(
        'alter table app.workspace_artifact_capacity alter column byte_limit set default 1073741824',
      );
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).resolves.toMatchObject({
        role: apiRole,
      });
    }

    await executeAsOwner(
      'alter table app.workspace_artifact_capacity drop constraint workspace_artifact_capacity_charged_count_valid',
    );
    try {
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).rejects.toThrow(capacityReadinessError);
    } finally {
      await executeAsOwner(`
        alter table app.workspace_artifact_capacity
          add constraint workspace_artifact_capacity_charged_count_valid
          check (charged_count >= 0)`);
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).resolves.toMatchObject({
        role: apiRole,
      });
    }
  });

  it('rejects runtime grant drift, including column-level writes', async () => {
    await executeAsOwner(
      `revoke select on app.workspace_artifact_capacity from ${apiRole}`,
    );
    try {
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).rejects.toThrow(capacityReadinessError);
    } finally {
      await executeAsOwner(
        `grant select on app.workspace_artifact_capacity to ${apiRole}`,
      );
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).resolves.toMatchObject({
        role: apiRole,
      });
    }

    await executeAsOwner(
      `grant update (charged_bytes) on app.workspace_artifact_capacity to ${apiRole}`,
    );
    try {
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).rejects.toThrow(capacityReadinessError);
    } finally {
      await executeAsOwner(
        `revoke update (charged_bytes) on app.workspace_artifact_capacity from ${apiRole}`,
      );
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).resolves.toMatchObject({
        role: apiRole,
      });
    }

    await executeAsOwner(
      `grant select on app.workspace_artifact_capacity to ${dispatcherRole}`,
    );
    try {
      await expect(
        checkDatabaseReadiness(dispatcherPool, readinessOptions),
      ).rejects.toThrow(capacityReadinessError);
    } finally {
      await executeAsOwner(
        `revoke select on app.workspace_artifact_capacity from ${dispatcherRole}`,
      );
      await expect(
        checkDatabaseReadiness(apiPool, readinessOptions),
      ).resolves.toMatchObject({
        role: apiRole,
      });
    }
  });
});
