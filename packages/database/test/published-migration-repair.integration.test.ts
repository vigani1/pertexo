import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const databaseName = `pertexo_test_migration_repair_${randomUUID().replaceAll('-', '')}`;
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: [
    'pertexo_migration',
    'pertexo_api',
    'pertexo_worker',
    'pertexo_dispatcher',
    'pertexo_maintenance',
    'pertexo_lifecycle_command',
    'pertexo_operator',
  ],
  databaseName,
  ownerRole: 'pertexo_owner',
});
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
  await fixture.create();
  priorDirectory = await mkdtemp(
    path.join(tmpdir(), 'pertexo-migration-repair-'),
  );
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
  const outcomes = await Promise.allSettled([
    priorDirectory === ''
      ? Promise.resolve()
      : rm(priorDirectory, { force: true, recursive: true }),
    fixture.drop(),
  ]);
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
  );
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      'Migration repair fixture cleanup failed',
    );
});

describe('selected published migration repair upgrade', () => {
  it('accepts two retained checksums and reconciles their damaged schema', async () => {
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
      '0069_regional_write_admission.sql',
      '0070_preview_execution_deadline.sql',
      '0071_oidc_browser_binding.sql',
      '0072_regional_replica_identity.sql',
      '0073_transient_data_retention.sql',
      '0074_retention_schedule_state_rls.sql',
      '0075_workspace_purge_step_release.sql',
      '0076_replay_lineage_retention.sql',
      '0077_replay_read_locks.sql',
      '0078_workflow_lifecycle_revision.sql',
      '0079_artifact_upload_capacity.sql',
      '0080_expired_artifact_upload_retention.sql',
      '0081_schedule_claim_concurrency.sql',
      '0082_legal_hold_destruction_serialization.sql',
      '0083_artifact_finalization_retention_deadline.sql',
      '0084_workspace_member_discovery_index.sql',
      '0085_artifact_media_type_http_safety.sql',
      '0086_operator_attempt_reclaim_state.sql',
      '0087_workspace_maintenance_rerun_purge.sql',
      '0088_sql_boundary_integrity.sql',
      '0089_oidc_capacity_lock_time.sql',
      '0090_workspace_discovery_policy.sql',
      '0091_workspace_discovery_scope.sql',
      '0092_workflow_run_history_indexes.sql',
      '0093_workspace_member_role_management.sql',
      '0094_workspace_invitations.sql',
      '0095_workspace_invitation_lifecycle_safety.sql',
      '0096_workspace_invitation_claim_cleanup_progress.sql',
      '0097_workspace_invitation_claim_scan_restart.sql',
      '0098_workspace_display_name.sql',
      '0099_workflow_recent_list.sql',
      '0100_workspace_invitation_delivery_snapshot.sql',
      '0101_better_auth_foundation.sql',
      '0102_better_auth_session_lifecycle.sql',
      '0103_durable_authentication_mail.sql',
      '0104_auth_email_change_session_revocation.sql',
      '0105_owned_auth_email_proofs.sql',
      '0106_auth_method_link_attempts.sql',
      '0107_legacy_method_migration_attempts.sql',
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
