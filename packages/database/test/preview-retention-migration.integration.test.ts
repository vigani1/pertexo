import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';
import { BASELINE_COMPATIBILITY_EXPECTATION } from './baseline-compatibility-fixture.js';

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
const databaseName = `pertexo_test_preview_retention_upgrade_${randomUUID().replaceAll('-', '')}`;

function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: databaseUrl(migrationBaseUrl),
  dispatcherRole: 'pertexo_dispatcher',
  maintenanceRole: 'pertexo_maintenance',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

async function createDatabase(): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
    );
  } finally {
    await admin.end();
  }
}

async function dropDatabase(): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
}

async function migrateThrough0023(): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-0023-'));
  try {
    const migrations = (await readdir(MIGRATIONS_DIRECTORY)).filter(
      (migration) => /^\d{4}_.+\.sql$/u.test(migration) && migration < '0024_',
    );
    await Promise.all(
      migrations.map((migration) =>
        copyFile(
          path.join(MIGRATIONS_DIRECTORY, migration),
          path.join(directory, migration),
        ),
      ),
    );
    await migrateDatabase(migrationConfig, directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

beforeAll(createDatabase);
afterAll(dropDatabase);

describe('preview retention migration', () => {
  it('retires legacy cleanup delivery for a retained 0023 preview', async () => {
    await migrateThrough0023();

    const actorUserId = randomUUID();
    const workspaceId = randomUUID();
    const workflowId = randomUUID();
    const previewRunId = randomUUID();
    const terminalPreviewRunId = randomUUID();
    const terminalPreviewAttemptId = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    const traceparent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
    const owner = new Pool({
      connectionString: migrationConfig.connectionString,
    });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query(
        `insert into app.users (id,email,display_name,status)
         values ($1,$2,'Retention upgrade','active')`,
        [actorUserId, `retention-upgrade-${actorUserId}@example.test`],
      );
      await owner.query(
        `insert into app.workspaces (id,name,slug,status,created_by)
         values ($1,'Retention upgrade',$2,'active',$3)`,
        [workspaceId, `retention-upgrade-${workspaceId}`, actorUserId],
      );
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        `insert into app.workflows
           (id,workspace_id,name,lifecycle_status,activation_status,created_by)
         values ($1,$2,'Retention target','active','inactive',$3)`,
        [workflowId, workspaceId, actorUserId],
      );
      await owner.query(
        `insert into app.preview_runs (
           id,workspace_id,workflow_id,draft_revision,draft_fingerprint,node_id,
           definition_key,definition_version,executor_key,executor_version,
           compatibility_release_epoch,compatibility_release_fingerprint,
           actor_user_id,idempotency_key_hash,request_hash,executable_node_json,
           input_ref,side_effect_class,may_contact_provider,
           may_cause_external_side_effect,dry_run,traceparent,expires_at
         ) values (
           $1,$2,$3,1,$4,'node-1','core.set',1,'core.set',1,$5,$6,$7,$8,$9,
           '{"id":"node-1","type":"core.set"}'::jsonb,
           '{"kind":"manual","value":null}'::jsonb,'safe',false,false,
           'not_supported',$10,$11
         )`,
        [
          previewRunId,
          workspaceId,
          workflowId,
          'c'.repeat(64),
          BASELINE_COMPATIBILITY_EXPECTATION.epoch,
          BASELINE_COMPATIBILITY_EXPECTATION.fingerprint,
          actorUserId,
          'd'.repeat(64),
          'e'.repeat(64),
          traceparent,
          expiresAt,
        ],
      );
      await owner.query(
        `insert into app.preview_runs (
           id,workspace_id,workflow_id,draft_revision,draft_fingerprint,node_id,
           definition_key,definition_version,executor_key,executor_version,
           compatibility_release_epoch,compatibility_release_fingerprint,
           actor_user_id,idempotency_key_hash,request_hash,executable_node_json,
           input_ref,side_effect_class,may_contact_provider,
           may_cause_external_side_effect,dry_run,status,safe_error_code,
           traceparent,started_at,completed_at,expires_at
         ) values (
           $1,$2,$3,1,$4,'node-2','core.set',1,'core.set',1,$5,$6,$7,$8,$9,
           '{"id":"node-2","type":"core.set"}'::jsonb,
           '{"kind":"manual","value":null}'::jsonb,'safe',false,false,
           'not_supported','failed','preview.upgrade_fixture',$10,
           clock_timestamp(),clock_timestamp(),$11
         )`,
        [
          terminalPreviewRunId,
          workspaceId,
          workflowId,
          'f'.repeat(64),
          BASELINE_COMPATIBILITY_EXPECTATION.epoch,
          BASELINE_COMPATIBILITY_EXPECTATION.fingerprint,
          actorUserId,
          '1'.repeat(64),
          '2'.repeat(64),
          traceparent,
          expiresAt,
        ],
      );
      await owner.query(
        `insert into app.preview_attempts (
           id,workspace_id,preview_run_id,status,side_effect_class,
           safe_error_code,started_at,completed_at
         ) values (
           $1,$2,$3,'failed','safe','preview.upgrade_fixture',
           clock_timestamp(),clock_timestamp()
         )`,
        [terminalPreviewAttemptId, workspaceId, terminalPreviewRunId],
      );
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await owner.end();
    }

    await expect(migrateDatabase(migrationConfig)).resolves.toEqual([
      '0024_preview_retention_cleanup.sql',
      '0025_preview_cleanup_idempotency.sql',
      '0026_preview_cleanup_terminal_guard.sql',
      '0027_preview_terminal_facts.sql',
      '0028_preview_terminal_fact_corrections.sql',
      '0029_provider_idempotency_key_invariants.sql',
      '0030_coordinator_retry_decisions.sql',
      '0031_due_node_wakeups.sql',
      '0032_for_each_barriers.sql',
      '0033_durable_wait.sql',
      '0034_run_failure_notifications.sql',
      '0035_slack_bot_token_connections.sql',
      '0036_resend_api_key_connections.sql',
      '0037_failure_notification_destinations.sql',
      '0038_execution_admission.sql',
      '0039_webhook_triggers.sql',
      '0040_schedule_triggers.sql',
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
      '0078_workflow_lifecycle_revision.sql',
      '0079_artifact_upload_capacity.sql',
    ]);

    const verification = new Pool({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
    });
    try {
      await verification.query('begin');
      await verification.query(
        "select set_config('app.workspace_id',$1,true)",
        [workspaceId],
      );
      const result = await verification.query<{
        available_at: Date;
        id: string;
        payload: Record<string, unknown>;
        payload_checksum: string;
      }>(
        `select id,payload,payload_checksum,available_at
           from app.outbox_events
          where workspace_id=$1 and aggregate_id=$2
            and job_name='sweep-expired-previews'`,
        [workspaceId, previewRunId],
      );
      expect(result.rows).toEqual([]);
      await verification.query('commit');
    } catch (error: unknown) {
      await verification.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await verification.end();
    }

    const apiVerification = new Pool({
      connectionString: databaseUrl(apiBaseUrl),
      max: 1,
    });
    try {
      await apiVerification.query('begin');
      await apiVerification.query(
        "select set_config('app.workspace_id',$1,true)",
        [workspaceId],
      );
      const terminalFacts = await apiVerification.query<{
        audit_count: string;
        audit_status: string;
        usage_count: string;
        usage_status: string;
      }>(
        `select
           (select count(*)::text from app.audit_events
             where workspace_id=$1 and action='preview.execution_terminal'
               and target_id=$2) as audit_count,
           (select metadata->>'status' from app.audit_events
             where workspace_id=$1 and action='preview.execution_terminal'
               and target_id=$2) as audit_status,
           (select count(*)::text from app.usage_events
             where workspace_id=$1 and resource_id=$2) as usage_count,
           (select metadata->>'status' from app.usage_events
             where workspace_id=$1 and resource_id=$2) as usage_status`,
        [workspaceId, terminalPreviewRunId],
      );
      expect(terminalFacts.rows).toEqual([
        {
          audit_count: '1',
          audit_status: 'failed',
          usage_count: '1',
          usage_status: 'failed',
        },
      ]);
      await apiVerification.query('commit');
    } catch (error: unknown) {
      await apiVerification.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await apiVerification.end();
    }
  });
});
