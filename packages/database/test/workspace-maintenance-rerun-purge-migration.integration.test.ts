import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../src/migrations.js';
import { copyMigrationsBefore } from './support/artifact-migration-fixture.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const databaseName = `pertexo_test_rerun_purge_${randomUUID().replaceAll('-', '')}`;
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: [
    'pertexo_migration',
    'pertexo_maintenance',
    'pertexo_operator',
  ],
  databaseName,
  ownerRole: 'pertexo_owner',
});
const withDatabase = (url: string): string => fixture.databaseUrl(url);
const migrationUrl = withDatabase(
  process.env.DATABASE_MIGRATION_URL ??
    'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
);
const maintenanceUrl = withDatabase(
  process.env.DATABASE_MAINTENANCE_URL ??
    'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
);
const operatorUrl = withDatabase(
  process.env.DATABASE_OPERATOR_URL ??
    'postgresql://pertexo_operator:pertexo-local-operator@localhost:5432/pertexo',
);
const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: migrationUrl,
  dispatcherRole: 'pertexo_dispatcher',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  maintenanceRole: 'pertexo_maintenance',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

let priorDirectory = '';
let owner: Pool;
let maintenance: Pool;
let operator: Pool;

beforeAll(async () => {
  await fixture.create();
  priorDirectory = await mkdtemp(path.join(tmpdir(), 'pertexo-rerun-purge-'));
  await copyMigrationsBefore(priorDirectory, '0087_');
  await migrateDatabase(migrationConfig, priorDirectory);
  owner = new Pool({ connectionString: migrationUrl, max: 1 });
  maintenance = new Pool({ connectionString: maintenanceUrl, max: 1 });
  operator = new Pool({ connectionString: operatorUrl, max: 1 });
});

afterAll(async () => {
  await Promise.all([owner.end(), maintenance.end(), operator.end()]);
  if (priorDirectory !== '')
    await rm(priorDirectory, { force: true, recursive: true });
  await fixture.drop();
});

describe('workspace maintenance-rerun purge upgrade', () => {
  it('upgrades a populated 0086 head with pending and completed rerun requests', async () => {
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const batchId = randomUUID();
    const purgeJobId = randomUUID();
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query(
        "insert into app.users(id,email,display_name) values($1,$2,'Rerun upgrade')",
        [userId, `${userId}@example.test`],
      );
      await owner.query(
        "insert into app.workspaces(id,name,slug,created_by) values($1,'Rerun upgrade',$2,$3)",
        [workspaceId, `rerun-upgrade-${workspaceId}`, userId],
      );
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        `insert into app.retention_batches(
          id,workspace_id,idempotency_key,retention_kind,cutoff_at,dry_run,
          requested_by,reason
        ) values($1,$2,'upgrade-batch','workflow_run_input',
          clock_timestamp(),true,'operator:q10','Upgrade fixture')`,
        [batchId, workspaceId],
      );
      await owner.query(
        `insert into app.workspace_purge_jobs(
          id,workspace_id,command_id,actor_ref,reason,occurred_at
        ) values($1,$2,$3,'operator:q10','Upgrade fixture',clock_timestamp())`,
        [purgeJobId, workspaceId, randomUUID()],
      );
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback');
      throw error;
    }

    const request = async (
      commandId: string,
      targetType: 'retention_batch' | 'workspace_purge_job',
      targetId: string,
    ): Promise<void> => {
      await operator.query(
        `select * from app.request_operator_maintenance_rerun(
          $1,$2,$3,$4,'operator:q10','Upgrade fixture',false
        )`,
        [commandId, workspaceId, targetType, targetId],
      );
    };
    await request(randomUUID(), 'retention_batch', batchId);
    await maintenance.query(
      'select * from app.process_operator_maintenance_rerun()',
    );
    await request(randomUUID(), 'workspace_purge_job', purgeJobId);
    await maintenance.query(
      'select * from app.process_operator_maintenance_rerun()',
    );
    await request(randomUUID(), 'retention_batch', batchId);
    await request(randomUUID(), 'workspace_purge_job', purgeJobId);

    await expect(migrateDatabase(migrationConfig)).resolves.toEqual([
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
      '0113_workflow_run_statistics_index.sql',
      '0115_webhook_delivery_log.sql',
    ]);
    await expect(migrateDatabase(migrationConfig)).resolves.toEqual([]);

    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      const requests = await owner.query<{
        count: number;
        status: string;
        target_type: string;
      }>(
        `select target_type,status,count(*)::int count
           from app.operator_maintenance_rerun_requests
          where workspace_id=$1 group by target_type,status
          order by target_type,status`,
        [workspaceId],
      );
      expect(requests.rows).toEqual([
        { count: 1, status: 'completed', target_type: 'retention_batch' },
        { count: 1, status: 'pending', target_type: 'retention_batch' },
        {
          count: 1,
          status: 'completed',
          target_type: 'workspace_purge_job',
        },
        {
          count: 1,
          status: 'pending',
          target_type: 'workspace_purge_job',
        },
      ]);
      const functionBody = await owner.query<{ body: string }>(
        `select pg_get_functiondef(
          'app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)'::regprocedure
        ) body`,
      );
      expect(functionBody.rows[0]?.body).toContain(
        'operator_maintenance_rerun_requests',
      );
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback');
      throw error;
    }
  });
});
