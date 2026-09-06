import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  operatorRole: 'pertexo_operator',
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
  priorDirectory = await mkdtemp(path.join(tmpdir(), 'webhook-prior-'));
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
      '0058_workspace_object_versions_purge.sql',
      '0059_workspace_purge_completion.sql',
      '0060_standard_retention_dry_run.sql',
      '0061_operator_outbox_redispatch.sql',
      '0062_operator_command_ledger.sql',
      '0063_operator_execution_recovery.sql',
      '0064_operator_trigger_reconciliation.sql',
      '0065_operator_run_replay.sql',
      '0066_operator_maintenance_rerun.sql',
      '0067_reconcile_published_migration_repairs.sql',
      '0068_restore_artifact_inventory.sql',
      '0069_regional_write_admission.sql',
      '0070_preview_execution_deadline.sql',
      '0071_oidc_browser_binding.sql',
      '0072_regional_replica_identity.sql',
      '0073_transient_data_retention.sql',
      '0074_retention_schedule_state_rls.sql',
      '0075_workspace_purge_step_release.sql',
      '0076_replay_lineage_retention.sql',
      '0077_replay_read_locks.sql',
    ]);
  });
});
