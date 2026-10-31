import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import {
  migrateDatabase,
  MIGRATIONS_DIRECTORY,
} from '../../../src/migrations.js';
import { createDisposableDatabaseFixture } from '../../support/postgres/disposable-database.js';
it('upgrades a populated standalone test without changing its source identity or legacy case charge', async () => {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_app', 'pertexo_migration', 'pertexo_maintenance'],
    databaseName: `pertexo_test_suite_upgrade_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-suite-upgrade-'));
  let admin: Pool | undefined;
  try {
    await fixture.create();
    for (const name of await readdir(MIGRATIONS_DIRECTORY))
      if (/^00(?:[01][0-9]|2[0-5])_.*\.sql$/u.test(name))
        await copyFile(join(MIGRATIONS_DIRECTORY, name), join(directory, name));
    const config = {
      appRole: 'pertexo_app',
      ownerRole: 'pertexo_owner',
      maintenanceRole: 'pertexo_maintenance',
      connectionString: fixture.databaseUrl(
        process.env.DATABASE_MIGRATION_URL ??
          'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
      ),
    };
    await migrateDatabase(config, directory);
    admin = new Pool({
      connectionString: fixture.databaseUrl(adminUrl),
      max: 1,
    });
    const user = randomUUID(),
      workspace = randomUUID(),
      workflow = randomUUID(),
      version = randomUUID(),
      run = randomUUID(),
      inputCase = randomUUID(),
      checksum = `wf:sha256:${'a'.repeat(64)}`;
    await admin.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Suite owner')",
      [user, `${user}@example.test`],
    );
    await admin.query(
      "insert into app.workspaces(id,name,slug,created_by) values($1,'Suite upgrade',$2,$3)",
      [workspace, `suite-${workspace}`, user],
    );
    await admin.query(
      "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Legacy test',$3)",
      [workflow, workspace, user],
    );
    await admin.query(
      "insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by) values($1,$2,$3,1,'{}','{}',$4,$5)",
      [version, workspace, workflow, checksum, user],
    );
    await admin.query("select set_config('app.workspace_id',$1,false)", [
      workspace,
    ]);
    await admin.query(
      "insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status) values($1,$2,$3,$1,'test','succeeded')",
      [run, workspace, workflow],
    );
    await admin.query(
      "insert into app.workflow_test_snapshots(run_id,workspace_id,draft_revision,graph_json,checksum,executable_json,dispositions,pins,expires_at) values($1,$2,1,'{}',$3,'{}','{}','{}',clock_timestamp()+interval '7 days')",
      [run, workspace, checksum],
    );
    await admin.query(
      "insert into app.workflow_input_cases(id,workspace_id,workflow_id,workflow_version_id,version_checksum,name) values($1,$2,$3,$4,$5,'Legacy input')",
      [inputCase, workspace, workflow, version, checksum],
    );
    await admin.query(
      "insert into app.workflow_input_case_payloads(workspace_id,case_id,revision,input,canonical_bytes) values($1,$2,1,'{}',2)",
      [workspace, inputCase],
    );
    expect(await migrateDatabase(config)).toEqual([
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
      '0060_write_probe.sql',
      '0061_sign_up_invitations.sql',
      '0062_endpoints_follow_the_step.sql',
      '0063_webhook_repeats_need_a_key.sql',
      '0064_instance_capacity.sql',
      '0065_run_delivery_deadline.sql',
      '0066_outbox_redeliveries.sql',
    ]);
    expect(
      (
        await admin.query(
          'select id,workflow_id from app.workflow_test_snapshots where id=$1',
          [run],
        )
      ).rows,
    ).toEqual([{ id: run, workflow_id: workflow }]);
    expect(
      (
        await admin.query(
          'select input,expectations,canonical_bytes from app.workflow_input_case_payloads where case_id=$1',
          [inputCase],
        )
      ).rows,
    ).toEqual([{ input: '{}', expectations: null, canonical_bytes: 2 }]);
    expect(
      (
        await admin.query(
          "select relname,relrowsecurity,relforcerowsecurity from pg_class where relnamespace='app'::regnamespace and relname in ('workflow_test_suites','workflow_test_suite_cases') order by relname",
        )
      ).rows,
    ).toEqual([
      {
        relname: 'workflow_test_suite_cases',
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: 'workflow_test_suites',
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
    ]);
  } finally {
    await admin?.end();
    await fixture.drop();
    await rm(directory, { recursive: true, force: true });
  }
});
