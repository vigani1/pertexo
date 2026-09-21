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
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerBaseUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const databaseName = `pertexo_test_webhook_prior_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = (() => {
  const url = new URL(migrationBaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
})();
const roleUrl = (baseUrl: string) => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};
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
let hardeningDirectory = '';

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
  hardeningDirectory = await mkdtemp(path.join(tmpdir(), 'webhook-hardening-'));
  for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
    if (/^\d{4}_.+\.sql$/u.test(name) && name < '0041_trigger_hardening.sql') {
      await copyFile(
        path.join(MIGRATIONS_DIRECTORY, name),
        path.join(priorDirectory, name),
      );
      await copyFile(
        path.join(MIGRATIONS_DIRECTORY, name),
        path.join(hardeningDirectory, name),
      );
    }
  }
  await copyFile(
    path.join(MIGRATIONS_DIRECTORY, '0041_trigger_hardening.sql'),
    path.join(hardeningDirectory, '0041_trigger_hardening.sql'),
  );
});

afterAll(async () => {
  if (priorDirectory !== '')
    await rm(priorDirectory, { recursive: true, force: true });
  if (hardeningDirectory !== '')
    await rm(hardeningDirectory, { recursive: true, force: true });
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('trigger hardening prior-head migration', () => {
  it('preserves retained webhook state and runtime authority after an exact 0040 head', async () => {
    const prior = await migrateDatabase(migrationConfig, priorDirectory);
    expect(prior.at(-1)).toBe('0040_schedule_triggers.sql');
    const ids = {
      delivery: randomUUID(),
      endpoint: randomUUID(),
      run: randomUUID(),
      secret: randomUUID(),
      trigger: randomUUID(),
      user: randomUUID(),
      version: randomUUID(),
      workflow: randomUUID(),
      workspace: randomUUID(),
    } as const;
    const endpointKeyHash = 'a'.repeat(64);
    const requestFingerprint = 'b'.repeat(64);
    const inspection = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await inspection.query('begin');
      await inspection.query('set local role pertexo_owner');
      await inspection.query(
        `insert into app.users(id,email,display_name)
         values($1,$2,'Prior webhook owner')`,
        [ids.user, `${ids.user}@example.test`],
      );
      await inspection.query(
        `insert into app.workspaces(id,name,slug,created_by)
         values($1,'Prior webhook',$2,$3)`,
        [ids.workspace, `prior-webhook-${ids.workspace}`, ids.user],
      );
      await inspection.query("select set_config('app.workspace_id',$1,true)", [
        ids.workspace,
      ]);
      await inspection.query(
        `insert into app.workflows(id,workspace_id,name,lifecycle_status,
           activation_status,published_version_id,created_by)
         values($1,$2,'Prior webhook workflow','active','active',null,$3)`,
        [ids.workflow, ids.workspace, ids.user],
      );
      await inspection.query(
        `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,
           schema_version,graph_json,checksum,executable_schema_version,executable_json,
           compatibility_release_epoch,published_by)
         values($1,$2,$3,1,1,'{}'::jsonb,$4,2,'{}'::jsonb,1,$5)`,
        [
          ids.version,
          ids.workspace,
          ids.workflow,
          `wf:v2:sha256:${'c'.repeat(64)}`,
          ids.user,
        ],
      );
      await inspection.query(
        'update app.workflows set published_version_id=$2 where id=$1',
        [ids.workflow, ids.version],
      );
      await inspection.query('commit');
      const apiSeed = new Pool({
        connectionString: roleUrl(apiBaseUrl),
        max: 1,
      });
      try {
        await apiSeed.query('begin');
        await apiSeed.query("select set_config('app.workspace_id',$1,true)", [
          ids.workspace,
        ]);
        await apiSeed.query(
          `insert into app.workflow_runs(id,workspace_id,workflow_id,
             workflow_version_id,trigger_type,status)
           values($1,$2,$3,$4,'webhook','queued')`,
          [ids.run, ids.workspace, ids.workflow, ids.version],
        );
        await apiSeed.query('commit');
      } finally {
        await apiSeed.end();
      }
      await inspection.query('begin');
      await inspection.query('set local role pertexo_owner');
      await inspection.query("select set_config('app.workspace_id',$1,true)", [
        ids.workspace,
      ]);
      await inspection.query(
        `insert into app.workflow_triggers(id,workspace_id,workflow_id,
           workflow_version_id,node_id,kind,status,desired_config,
           config_fingerprint,health_status)
         values($1,$2,$3,$4,'webhook','webhook','active','{}'::jsonb,$5,'healthy')`,
        [
          ids.trigger,
          ids.workspace,
          ids.workflow,
          ids.version,
          `trigger:v1:sha256:${'d'.repeat(64)}`,
        ],
      );
      await inspection.query('commit');
      const apiWebhookSeed = new Pool({
        connectionString: roleUrl(apiBaseUrl),
        max: 1,
      });
      let beforeRows: readonly Record<string, unknown>[] = [];
      try {
        await apiWebhookSeed.query('begin');
        await apiWebhookSeed.query(
          "select set_config('app.workspace_id',$1,true)",
          [ids.workspace],
        );
        await apiWebhookSeed.query(
          `insert into app.webhook_trigger_secret_versions(id,workspace_id,
             trigger_id,schema_version,kms_key_reference,encrypted_data_key,
             ciphertext,nonce,auth_tag,created_by)
           values($1,$2,$3,1,'kms://prior','prior-key','prior-cipher',
             'prior-nonce','prior-auth-tag',$4)`,
          [ids.secret, ids.workspace, ids.trigger, ids.user],
        );
        await apiWebhookSeed.query(
          `insert into app.webhook_trigger_endpoints(id,workspace_id,trigger_id,
             endpoint_key_hash,current_secret_version_id)
           values($1,$2,$3,$4,$5)`,
          [
            ids.endpoint,
            ids.workspace,
            ids.trigger,
            endpointKeyHash,
            ids.secret,
          ],
        );
        await apiWebhookSeed.query('commit');
      } finally {
        await apiWebhookSeed.end();
      }
      await inspection.query('begin');
      await inspection.query('set local role pertexo_owner');
      await inspection.query("select set_config('app.workspace_id',$1,true)", [
        ids.workspace,
      ]);
      const endpointBefore = await inspection.query<Record<string, unknown>>(
        `select endpoint.id endpoint_id,endpoint.endpoint_key_hash,
                endpoint.current_secret_version_id,secret.kms_key_reference,
                secret.encrypted_data_key,secret.ciphertext,secret.nonce,secret.auth_tag
           from app.webhook_trigger_endpoints endpoint
           join app.webhook_trigger_secret_versions secret
             on secret.id=endpoint.current_secret_version_id
          where endpoint.id=$1`,
        [ids.endpoint],
      );
      await inspection.query('commit');
      await expect(
        migrateDatabase(migrationConfig, hardeningDirectory),
      ).resolves.toEqual(['0041_trigger_hardening.sql']);
      await inspection.query('begin');
      await inspection.query('set local role pertexo_owner');
      await inspection.query("select set_config('app.workspace_id',$1,true)", [
        ids.workspace,
      ]);
      const endpointAfter = await inspection.query<Record<string, unknown>>(
        `select endpoint.id endpoint_id,endpoint.endpoint_key_hash,
                endpoint.current_secret_version_id,secret.kms_key_reference,
                secret.encrypted_data_key,secret.ciphertext,secret.nonce,secret.auth_tag
           from app.webhook_trigger_endpoints endpoint
           join app.webhook_trigger_secret_versions secret
             on secret.id=endpoint.current_secret_version_id
          where endpoint.id=$1`,
        [ids.endpoint],
      );
      await inspection.query('commit');
      expect(endpointAfter.rows).toEqual(endpointBefore.rows);

      const apiReplaySeed = new Pool({
        connectionString: roleUrl(apiBaseUrl),
        max: 1,
      });
      try {
        await apiReplaySeed.query('begin');
        await apiReplaySeed.query(
          "select set_config('app.workspace_id',$1,true)",
          [ids.workspace],
        );
        await apiReplaySeed.query(
          `insert into app.webhook_trigger_deliveries(id,workspace_id,trigger_id,
             endpoint_id,workflow_run_id,dedupe_kind)
           values($1,$2,$3,$4,$5,'keyed')`,
          [ids.delivery, ids.workspace, ids.trigger, ids.endpoint, ids.run],
        );
        await apiReplaySeed.query(
          `insert into app.webhook_trigger_replay_records(workspace_id,endpoint_id,
             dedupe_kind,dedupe_key_hash,request_fingerprint,delivery_id,
             workflow_run_id,expires_at)
           values($1,$2,'keyed',$3,$4,$5,$6,clock_timestamp()+interval '24 hours')`,
          [
            ids.workspace,
            ids.endpoint,
            endpointKeyHash,
            requestFingerprint,
            ids.delivery,
            ids.run,
          ],
        );
        await apiReplaySeed.query('commit');
      } finally {
        await apiReplaySeed.end();
      }
      await inspection.query('begin');
      await inspection.query('set local role pertexo_owner');
      await inspection.query("select set_config('app.workspace_id',$1,true)", [
        ids.workspace,
      ]);
      const before = await inspection.query<Record<string, unknown>>(
        `select endpoint.id endpoint_id,endpoint.endpoint_key_hash,
                endpoint.current_secret_version_id,secret.kms_key_reference,
                secret.encrypted_data_key,secret.ciphertext,secret.nonce,secret.auth_tag,
                replay.dedupe_kind,replay.dedupe_key_hash,replay.request_fingerprint,
                replay.delivery_id,replay.workflow_run_id
           from app.webhook_trigger_endpoints endpoint
           join app.webhook_trigger_secret_versions secret
             on secret.id=endpoint.current_secret_version_id
           join app.webhook_trigger_replay_records replay
             on replay.endpoint_id=endpoint.id
          where endpoint.id=$1`,
        [ids.endpoint],
      );
      beforeRows = before.rows;
      await inspection.query('commit');

      await expect(migrateDatabase(migrationConfig)).resolves.toEqual([
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
      ]);
      await inspection.query('begin');
      await inspection.query('set local role pertexo_owner');
      await inspection.query("select set_config('app.workspace_id',$1,true)", [
        ids.workspace,
      ]);
      const after = await inspection.query<Record<string, unknown>>(
        `select endpoint.id endpoint_id,endpoint.endpoint_key_hash,
                endpoint.current_secret_version_id,secret.kms_key_reference,
                secret.encrypted_data_key,secret.ciphertext,secret.nonce,secret.auth_tag,
                replay.dedupe_kind,replay.dedupe_key_hash,replay.request_fingerprint,
                replay.delivery_id,replay.workflow_run_id
           from app.webhook_trigger_endpoints endpoint
           join app.webhook_trigger_secret_versions secret
             on secret.id=endpoint.current_secret_version_id
           join app.webhook_trigger_replay_records replay
             on replay.endpoint_id=endpoint.id
          where endpoint.id=$1`,
        [ids.endpoint],
      );
      await inspection.query('commit');
      expect(after.rows).toEqual(beforeRows);

      const api = new Pool({
        connectionString: roleUrl(apiBaseUrl),
        max: 1,
      });
      const worker = new Pool({
        connectionString: roleUrl(workerBaseUrl),
        max: 1,
      });
      try {
        await expect(
          api.query<{ endpoint_id: string }>(
            'select endpoint_id from app.resolve_public_webhook_endpoint($1)',
            [endpointKeyHash],
          ),
        ).resolves.toMatchObject({ rows: [{ endpoint_id: ids.endpoint }] });
        await expect(
          api.query(
            'select ciphertext from app.webhook_trigger_secret_versions',
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          worker.query(
            'select endpoint_id from app.resolve_public_webhook_endpoint($1)',
            [endpointKeyHash],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await Promise.allSettled([api.end(), worker.end()]);
      }
    } finally {
      await inspection.end();
    }
  });
});
