import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
const databaseName = `pertexo_test_webhook_prior_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = (() => {
  const url = new URL(migrationBaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
})();
const migrationConfig = {
  connectionString: databaseUrl,
  ownerRole: 'pertexo_owner',
  apiRuntimeRole: 'pertexo_api',
  workerRuntimeRole: 'pertexo_worker',
  dispatcherRole: 'pertexo_dispatcher',
  maintenanceRole: 'pertexo_maintenance',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
} as const;
let priorDirectory = '';

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,pertexo_api,pertexo_worker,pertexo_dispatcher`,
    );
  } finally {
    await admin.end();
  }
  priorDirectory = await mkdtemp(
    '/private/var/folders/1b/2tzp51hj4wg0rcvmj2j_pwlh0000gn/T/opencode/webhook-prior-',
  );
  for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
    if (/^\d{4}_.+\.sql$/u.test(name) && name < '0041_trigger_hardening.sql')
      await copyFile(
        path.join(MIGRATIONS_DIRECTORY, name),
        path.join(priorDirectory, name),
      );
  }
});

afterAll(async () => {
  if (priorDirectory !== '')
    await rm(priorDirectory, { recursive: true, force: true });
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('trigger hardening prior-head migration', () => {
  it('applies trigger hardening after an exact 0040 head', async () => {
    const prior = await migrateDatabase(migrationConfig, priorDirectory);
    expect(prior.at(-1)).toBe('0040_schedule_triggers.sql');
    await expect(migrateDatabase(migrationConfig)).resolves.toEqual([
      '0041_trigger_hardening.sql',
      '0042_worker_run_admission_lock.sql',
      '0043_workflow_run_input_retention.sql',
      '0044_retention_control_foundation.sql',
      '0045_control_ledger_command_lock.sql',
      '0046_workspace_deletion_control_projection.sql',
      '0047_workspace_lifecycle_command_intents.sql',
      '0048_workspace_lifecycle_command_hardening.sql',
      '0049_workspace_deletion_side_effects.sql',
      '0050_workspace_lifecycle_api_authority.sql',
      '0051_workflow_run_input_retention_dry_run.sql',
      '0052_workflow_run_input_retention_enforcement.sql',
      '0053_preview_retention_enforcement.sql',
      '0054_workflow_run_input_retention_scheduling.sql',
      '0055_standard_retention_classes.sql',
      '0056_workspace_purge_foundation.sql',
      '0057_workspace_tenant_rows_purge.sql',
    ]);
  });
});
