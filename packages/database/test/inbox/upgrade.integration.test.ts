import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../../src/migrations.js';
import { parseDatabaseConfig } from '../../src/config.js';
import { createWorkspaceInboxDatabase } from '../../src/inbox/threads/reader.repository.js';
import { createDisposableDatabaseFixture } from '../support/postgres/disposable-database.js';
it('upgrades populated workflow threads and private read revisions without changing their cut or precision', async () => {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_app', 'pertexo_migration', 'pertexo_maintenance'],
    databaseName: `pertexo_test_notice_upgrade_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-notice-upgrade-'));
  let admin: Pool | undefined;
  let read: ReturnType<typeof createWorkspaceInboxDatabase> | undefined;
  try {
    await fixture.create();
    for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
      if (/^00(?:0[0-9]|1[01])_.*\.sql$/u.test(name))
        await copyFile(join(MIGRATIONS_DIRECTORY, name), join(directory, name));
    }
    const migration = {
      appRole: 'pertexo_app',
      ownerRole: 'pertexo_owner',
      maintenanceRole: 'pertexo_maintenance',
      connectionString: fixture.databaseUrl(
        process.env.DATABASE_MIGRATION_URL ??
          'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
      ),
    };
    await migrateDatabase(migration, directory);
    admin = new Pool({
      connectionString: fixture.databaseUrl(adminUrl),
      max: 1,
    });
    const owner = randomUUID(),
      workspaceId = randomUUID(),
      workflowId = randomUUID(),
      runId = randomUUID();
    await admin.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Upgrade owner')",
      [owner, `${owner}@example.test`],
    );
    await admin.query(
      "insert into app.workspaces(id,name,slug,created_by) values($1,'Upgrade proof',$2,$3)",
      [workspaceId, `upgrade-${workspaceId}`, owner],
    );
    await admin.query(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active')",
      [workspaceId, owner],
    );
    await admin.query(
      "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Preserved workflow',$3)",
      [workflowId, workspaceId, owner],
    );
    const old = await admin.query<{ revision: string; latest: string }>(
      "insert into app.workspace_inbox_threads(workspace_id,workflow_id,revision,occurrence_count,first_occurred_at,latest_occurred_at,latest_run_id,latest_kind) values($1,$2,nextval('app.workspace_inbox_revision_seq'),3,clock_timestamp()-interval '1 hour',clock_timestamp(),$3,'failed') returning revision::text,to_char(latest_occurred_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') latest",
      [workspaceId, workflowId, runId],
    );
    const before = old.rows[0];
    if (before === undefined) throw new Error('Expected old thread');
    await admin.query(
      'insert into app.workspace_inbox_reads(workspace_id,user_id,workflow_id,read_revision) values($1,$2,$3,$4)',
      [workspaceId, owner, workflowId, before.revision],
    );
    expect(await migrateDatabase(migration)).toEqual([
      '0012_personal_notices.sql',
      '0013_task_context.sql',
      '0014_error_workflow_queue_wait.sql',
      '0015_notice_audience_fence.sql',
      '0016_variable_set_revisions.sql',
      '0017_system_mail_deliveries.sql',
      '0018_workflow_polish.sql',
      '0019_pinned_step_samples.sql',
      '0020_webhook_responses.sql',
      '0021_code_diagnostics.sql',
      '0022_draft_workflow_tests.sql',
      '0023_webhook_authentication.sql',
      '0024_concurrency_skip.sql',
      '0025_capacity_warnings.sql',
      '0026_workflow_test_suites.sql',
      '0027_workspace_data_tables.sql',
      '0028_trigger_event_coordination.sql',
      '0029_data_table_column_identity.sql',
      '0030_audit_retention.sql',
      '0031_publication_review.sql',
      '0032_federated_sign_in.sql',
      '0033_organization_oidc.sql',
      '0034_organization_directory.sql',
      '0035_workflow_promotions.sql',
      '0036_workflow_collaboration.sql',
      '0037_keep_field_order.sql',
      '0038_step_refusal_reasons.sql',
      '0039_table_names_with_spaces.sql',
      '0040_two_factor_sign_in.sql',
      '0041_two_factor_security_notices.sql',
      '0042_http_retry_delay.sql',
      '0043_webhook_test_events.sql',
      '0044_canvas_notes.sql',
      '0045_captured_sample_origin.sql',
      '0046_signing_key.sql',
      '0047_run_values.sql',
      '0048_callback_waits.sql',
      '0049_live_callback_keys.sql',
      '0050_folder_access.sql',
      '0051_connection_sharing.sql',
      '0052_publication_reuse_candidates.sql',
      '0053_remove_artifact_lookup.sql',
      '0054_form_uploads.sql',
      '0055_task_timeout_output.sql',
      '0056_unsent_public_form_uploads.sql',
      '0057_users_canonical_email_index.sql',
      '0058_workspace_reactivation.sql',
      '0059_suspended_inbox.sql',
    ]);
    read = createWorkspaceInboxDatabase(
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(
          process.env.DATABASE_URL ??
            'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
        ),
        max: 1,
      }),
    );
    const page = await read.listThreads({
      workspaceId,
      actorId: owner,
      filter: 'all',
      limit: 25,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      noticeKind: 'workflow_failure',
      workflowId,
      revision: before.revision,
      unread: false,
      occurrenceCount: 3,
      latestOccurredAt: before.latest,
      latestRunId: runId,
    });
    const migrated = await admin.query<{
      thread_id: string;
      read_revision: string;
    }>(
      'select thread_id,read_revision::text from app.workspace_inbox_reads where workspace_id=$1',
      [workspaceId],
    );
    expect(migrated.rows).toEqual([
      { thread_id: page.items[0]?.id, read_revision: before.revision },
    ]);
  } finally {
    await read?.close();
    await admin?.end();
    await fixture.drop();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
