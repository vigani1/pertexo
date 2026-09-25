import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
const databaseName = `pertexo_test_schedule_claim_migration_${randomUUID().replaceAll('-', '')}`;
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

const helperFunctionNames = [
  'schedule_claim_is_eligible',
  'complete_trigger_schedule_claim',
  'release_trigger_schedule_claim',
  'defer_trigger_schedule_claim',
  'fail_trigger_schedule_claim',
] as const;
const expectedSuffix = [
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
  '0108_workflow_name_revision.sql',
  '0110_workspace_member_removal.sql',
  '0111_user_display_name.sql',
  '0113_workflow_run_statistics_index.sql',
  '0115_webhook_delivery_log.sql',
  '0116_workspace_member_departure.sql',
  '0117_workspace_member_suspension.sql',
  '0118_workspace_ownership_transfer.sql',
] as const;

interface FunctionMetadata {
  identity_arguments: string;
  name: string;
  owner: string;
  privileges: string[];
  proconfig: string[] | null;
  prosecdef: boolean;
}

interface ScheduleState {
  admission_deferred_until: Date | null;
  anchor_at: Date;
  config_fingerprint: string;
  cron_expression: string | null;
  health_status: string;
  interval_minutes: number | null;
  last_error_code: string | null;
  last_fire_at: Date | null;
  lease_acquired_at: Date | null;
  lease_expires_at: Date | null;
  lease_owner: string | null;
  lease_token: string | null;
  misfire_policy: string;
  next_fire_at: Date;
  recurrence_kind: string;
  status: string;
  timezone: string | null;
  trigger_id: string;
  workspace_id: string;
}

interface OccurrenceState {
  created_at: Date;
  disposition: string;
  id: string;
  scheduled_at: Date;
  trigger_id: string;
  workflow_run_id: string | null;
  workspace_id: string;
}

let priorDirectory = '';
let priorHead = '';
let appliedSuffix: readonly string[] = [];
let claimBefore: FunctionMetadata[] = [];
let claimAfter: FunctionMetadata[] = [];
let helpersBefore: FunctionMetadata[] = [];
let helpersAfter: FunctionMetadata[] = [];
let claimDefinition = '';
let scheduleBefore: ScheduleState | undefined;
let scheduleAfter: ScheduleState | undefined;
let occurrenceBefore: OccurrenceState | undefined;
let occurrenceAfter: OccurrenceState | undefined;
let databaseTimeAfter: Date | undefined;
let backfilledExpiry: Date | undefined;
const finalizedAt = new Date('2026-09-01T00:00:00.000Z');

async function readFunctionMetadata(
  pool: Pool,
  names: readonly string[],
): Promise<FunctionMetadata[]> {
  const result = await pool.query<FunctionMetadata>(
    `select p.proname name,pg_get_function_identity_arguments(p.oid) identity_arguments,
       pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,
       coalesce(array_agg(
         case when acl.grantee=0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end
           || ':' || acl.privilege_type
         order by acl.grantee,acl.privilege_type
       ) filter(where acl.grantee is not null),'{}'::text[]) privileges
       from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       left join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl on true
      where n.nspname='app' and p.proname = any($1::text[])
      group by p.oid,p.proname,p.prosecdef,p.proconfig,p.proowner
      order by p.proname,pg_get_function_identity_arguments(p.oid)`,
    [names],
  );
  return result.rows;
}

async function readClaimFunctionDefinition(pool: Pool): Promise<string> {
  const result = await pool.query<{ body: string }>(
    `select pg_get_functiondef(p.oid) body
       from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='app' and p.proname='claim_due_trigger_schedules'`,
  );
  const body = result.rows[0]?.body;
  if (body === undefined)
    throw new Error('claim_due_trigger_schedules definition was not found');
  return body;
}

function readDueCte(definition: string): string {
  const due = /\bdue\s+as\s*\(([\s\S]*?)\),\s*claimed\s+as/iu.exec(
    definition,
  )?.[1];
  if (due === undefined)
    throw new Error('claim_due_trigger_schedules due CTE was not found');
  return due;
}

async function readScheduleState(
  pool: Pool,
  triggerId: string,
): Promise<ScheduleState> {
  const result = await pool.query<ScheduleState>(
    `select trigger_id,workspace_id,recurrence_kind,cron_expression,timezone,
            interval_minutes,misfire_policy,config_fingerprint,anchor_at,next_fire_at,
            last_fire_at,status,health_status,last_error_code,lease_owner,lease_token,
            lease_acquired_at,lease_expires_at,admission_deferred_until
       from app.trigger_schedules where trigger_id=$1`,
    [triggerId],
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new Error('seeded trigger schedule was not found');
  return row;
}

async function readOccurrenceState(
  pool: Pool,
  occurrenceId: string,
): Promise<OccurrenceState> {
  const result = await pool.query<OccurrenceState>(
    `select id,workspace_id,trigger_id,scheduled_at,disposition,workflow_run_id,created_at
       from app.trigger_schedule_occurrences where id=$1`,
    [occurrenceId],
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new Error('seeded trigger schedule occurrence was not found');
  return row;
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,pertexo_api,pertexo_worker,pertexo_dispatcher,pertexo_maintenance,pertexo_lifecycle_command,pertexo_operator`,
    );
  } finally {
    await admin.end();
  }

  priorDirectory = await mkdtemp(path.join(tmpdir(), 'schedule-claim-prior-'));
  for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
    if (/^\d{4}_[a-z0-9_]+\.sql$/u.test(name) && name < '0081_')
      await copyFile(
        path.join(MIGRATIONS_DIRECTORY, name),
        path.join(priorDirectory, name),
      );
  }

  const prior = await migrateDatabase(migrationConfig, priorDirectory);
  priorHead = prior.at(-1) ?? '';
  const inspection = new Pool({ connectionString: databaseUrl, max: 1 });
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const workflowId = randomUUID();
  const versionId = randomUUID();
  const triggerId = randomUUID();
  const occurrenceId = randomUUID();
  const artifactId = randomUUID();
  const legacyExpiry = new Date(finalizedAt.getTime() + 15 * 60_000);
  const scheduledAt = new Date('2026-08-31T23:58:00.000Z');
  const fingerprint = `trigger:v1:sha256:${'c'.repeat(64)}`;
  try {
    await inspection.query('begin');
    await inspection.query('set local role pertexo_owner');
    await inspection.query(
      `insert into app.users(id,email,display_name)
       values($1,$2,'Legacy schedule owner')`,
      [userId, `${userId}@example.test`],
    );
    await inspection.query(
      `insert into app.workspaces(id,name,slug,created_by)
       values($1,'Legacy schedule',$2,$3)`,
      [workspaceId, `legacy-schedule-${workspaceId}`, userId],
    );
    await inspection.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await inspection.query(
      `insert into app.workflows(id,workspace_id,name,lifecycle_status,
         activation_status,published_version_id,created_by)
       values($1,$2,'Legacy scheduled workflow','active','active',null,$3)`,
      [workflowId, workspaceId, userId],
    );
    await inspection.query(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,
         schema_version,graph_json,checksum,executable_schema_version,executable_json,
         compatibility_release_epoch,published_by)
       values($1,$2,$3,1,1,
         '{"schemaVersion":1,"settings":{},"nodes":[],"edges":[]}'::jsonb,
         $4,2,'{}'::jsonb,1,$5)`,
      [
        versionId,
        workspaceId,
        workflowId,
        `wf:v2:sha256:${'d'.repeat(64)}`,
        userId,
      ],
    );
    await inspection.query(
      'update app.workflows set published_version_id=$2 where id=$1',
      [workflowId, versionId],
    );
    await inspection.query(
      `insert into app.workflow_triggers(id,workspace_id,workflow_id,
         workflow_version_id,node_id,kind,status,desired_config,
         config_fingerprint,health_status)
       values($1,$2,$3,$4,'legacy-schedule','schedule','active',$5::jsonb,$6,'healthy')`,
      [
        triggerId,
        workspaceId,
        workflowId,
        versionId,
        JSON.stringify({
          kind: 'interval',
          intervalMinutes: 5,
          misfirePolicy: 'catch_up_once',
        }),
        fingerprint,
      ],
    );
    await inspection.query(
      `insert into app.trigger_schedules(trigger_id,workspace_id,recurrence_kind,
         interval_minutes,misfire_policy,config_fingerprint,anchor_at,next_fire_at)
       values($1,$2,'interval',5,'catch_up_once',$3,$4,$5)`,
      [
        triggerId,
        workspaceId,
        fingerprint,
        new Date('2026-08-31T23:55:00.000Z'),
        new Date('2026-09-01T00:00:00.000Z'),
      ],
    );
    await inspection.query(
      `insert into app.trigger_schedule_occurrences(
         id,workspace_id,trigger_id,scheduled_at,disposition)
       values($1,$2,$3,$4,'skipped')`,
      [occurrenceId, workspaceId, triggerId, scheduledAt],
    );
    await inspection.query(
      `insert into app.artifacts(
         id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
         status,expires_at,finalized_at,created_at,updated_at
       ) values(
         $1,$2,'user-upload',$3,'application/octet-stream',17,$4,
         'available',$5,$6,$6,$6
       )`,
      [
        artifactId,
        workspaceId,
        `workspaces/${workspaceId}/artifacts/${artifactId}`,
        'f'.repeat(64),
        legacyExpiry,
        finalizedAt,
      ],
    );
    await inspection.query('commit');
  } catch (error: unknown) {
    await inspection.query('rollback');
    throw error;
  }

  await inspection.query('begin');
  try {
    await inspection.query('set local role pertexo_owner');
    const claimed = await inspection.query<{ lease_token: string }>(
      `select lease_token from app.claim_due_trigger_schedules($1,1,300)
        where trigger_id=$2`,
      ['migration-retained-claim', triggerId],
    );
    if (claimed.rows[0]?.lease_token === undefined)
      throw new Error('seeded trigger schedule was not claimed');
    await inspection.query('commit');
  } catch (error: unknown) {
    await inspection.query('rollback');
    throw error;
  }

  await inspection.query('set role pertexo_owner');
  claimBefore = await readFunctionMetadata(inspection, [
    'claim_due_trigger_schedules',
  ]);
  helpersBefore = await readFunctionMetadata(inspection, helperFunctionNames);
  scheduleBefore = await readScheduleState(inspection, triggerId);
  occurrenceBefore = await readOccurrenceState(inspection, occurrenceId);

  appliedSuffix = await migrateDatabase(migrationConfig);

  claimAfter = await readFunctionMetadata(inspection, [
    'claim_due_trigger_schedules',
  ]);
  helpersAfter = await readFunctionMetadata(inspection, helperFunctionNames);
  claimDefinition = await readClaimFunctionDefinition(inspection);
  scheduleAfter = await readScheduleState(inspection, triggerId);
  occurrenceAfter = await readOccurrenceState(inspection, occurrenceId);
  const postMigration = await inspection.query<{
    database_time: Date;
    expires_at: Date;
  }>(
    `select clock_timestamp() database_time,
            (select expires_at from app.artifacts
              where workspace_id=$1 and id=$2) expires_at`,
    [workspaceId, artifactId],
  );
  databaseTimeAfter = postMigration.rows[0]?.database_time;
  backfilledExpiry = postMigration.rows[0]?.expires_at;
  await inspection.end();
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

describe('schedule claim migration upgrade', () => {
  it('upgrades exactly from 0080 while preserving claim helper security', () => {
    expect(priorHead).toBe('0080_expired_artifact_upload_retention.sql');
    expect(appliedSuffix).toEqual(expectedSuffix);
    expect(claimAfter).toEqual(claimBefore);
    expect(helpersAfter).toEqual(helpersBefore);

    const claim = claimAfter[0];
    if (claim === undefined)
      throw new Error('claim_due_trigger_schedules metadata was not found');
    expect(claim.owner).toBe('pertexo_owner');
    expect(claim.prosecdef).toBe(true);
    const normalizedConfig = (claim.proconfig ?? []).map((setting) =>
      setting.replaceAll(/\s+/gu, ''),
    );
    expect(normalizedConfig).toEqual(
      expect.arrayContaining([
        'search_path=pg_catalog,app,pg_temp',
        'row_security=on',
      ]),
    );
    expect(claim.privileges).toContain('pertexo_worker:EXECUTE');
    expect(claim.privileges).not.toContain('PUBLIC:EXECUTE');
    expect(claim.privileges).not.toContain('pertexo_api:EXECUTE');

    const dueCte = readDueCte(claimDefinition);
    expect(claimDefinition).toMatch(/ranked\s+as/iu);
    expect(dueCte).toMatch(/schedule\.status\s*=\s*'enabled'/iu);
    expect(dueCte).toMatch(/schedule\.next_fire_at\s*<=\s*v_observed_at/iu);
    expect(dueCte).toMatch(/schedule\.admission_deferred_until\s+is\s+null/iu);
    expect(dueCte).toMatch(/schedule\.lease_expires_at\s+is\s+null/iu);
    expect(dueCte).toMatch(/trigger\.status\s*=\s*'active'/iu);
    expect(dueCte).toMatch(/for\s+update\s+of\s+schedule\s+skip\s+locked/iu);
  });

  it('retains the schedule, live claim, and occurrence across the upgrade', () => {
    expect(scheduleAfter).toEqual(scheduleBefore);
    expect(occurrenceAfter).toEqual(occurrenceBefore);
    expect(scheduleAfter).toMatchObject({
      health_status: 'healthy',
      interval_minutes: 5,
      lease_owner: 'migration-retained-claim',
      recurrence_kind: 'interval',
      status: 'enabled',
    });
    expect(scheduleAfter?.lease_token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(scheduleAfter?.lease_expires_at?.getTime()).toBeGreaterThan(
      databaseTimeAfter?.getTime() ?? Number.POSITIVE_INFINITY,
    );
    expect(occurrenceAfter).toMatchObject({
      disposition: 'skipped',
      trigger_id: scheduleAfter?.trigger_id,
      workflow_run_id: null,
      workspace_id: scheduleAfter?.workspace_id,
    });
  });

  it('backfills the unrelated legacy artifact finalization expiry', () => {
    expect(backfilledExpiry?.getTime()).toBe(
      finalizedAt.getTime() + 30 * 24 * 60 * 60_000,
    );
  });
});
