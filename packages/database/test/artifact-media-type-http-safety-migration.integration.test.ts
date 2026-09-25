import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../src/migrations.js';
import {
  copyMigrationsBefore,
  createArtifactMigrationConfig,
} from './support/artifact-migration-fixture.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const databaseName = `pertexo_test_0085_media_${randomUUID().replaceAll('-', '')}`;
const database = createDisposableDatabaseFixture({
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
const { databaseUrl } = database;
const migrationConfig = createArtifactMigrationConfig(
  databaseUrl(migrationBaseUrl),
);

async function closeFixtureResources(
  owner: Pool,
  priorDirectory: string,
): Promise<void> {
  const cleanup = await Promise.allSettled([
    owner.end(),
    rm(priorDirectory, { recursive: true, force: true }),
  ]);
  const failures: unknown[] = [];
  for (const result of cleanup)
    if (result.status === 'rejected') failures.push(result.reason);
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      'Artifact media migration fixture cleanup failed',
    );
}

beforeAll(database.create, 30_000);
afterAll(database.drop);

describe('artifact media-type HTTP safety prior-head migration', () => {
  it('fails closed on unsafe inventory, then enforces the aligned constraint', async () => {
    const priorDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-0084-artifact-media-'),
    );
    const workspaceId = randomUUID();
    const artifactId = randomUUID();
    const owner = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
      max: 1,
    });
    try {
      await copyMigrationsBefore(priorDirectory, '0085_');
      const prior = await migrateDatabase(migrationConfig, priorDirectory);
      expect(prior.at(-1)).toBe('0084_workspace_member_discovery_index.sql');

      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        `insert into app.workspace_artifact_capacity
           (workspace_id,byte_limit,artifact_count_limit,charged_bytes,charged_count)
         values($1,1000,100,0,0)`,
        [workspaceId],
      );
      await owner.query(
        `insert into app.artifacts
           (id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
            status,expires_at)
         values($1,$2,'user-upload',
           'workspaces/'||$2::uuid::text||'/artifacts/'||$1::uuid::text,
           $3,5,$4,'pending',clock_timestamp()+interval '15 minutes')`,
        [artifactId, workspaceId, 'application/js\u000bon', 'a'.repeat(64)],
      );
      await owner.query('commit');

      await expect(migrateDatabase(migrationConfig)).rejects.toThrow(
        /artifacts_media_type_format/u,
      );

      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query('alter table app.artifacts disable trigger user');
      await owner.query(
        `update app.artifacts set media_type='application/json'
          where workspace_id=$1 and id=$2`,
        [workspaceId, artifactId],
      );
      await owner.query('alter table app.artifacts enable trigger user');
      await owner.query('commit');

      await expect(migrateDatabase(migrationConfig)).resolves.toEqual([
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
      ]);

      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query('alter table app.artifacts disable trigger user');
      await expect(
        owner.query(
          `update app.artifacts set media_type=$3
            where workspace_id=$1 and id=$2`,
          [workspaceId, artifactId, 'application/js\u007fon'],
        ),
      ).rejects.toThrow(/artifacts_media_type_format/u);
      await owner.query('rollback');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await closeFixtureResources(owner, priorDirectory);
    }
  }, 60_000);
});
