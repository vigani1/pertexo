import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import {
  migrateDatabase,
  MIGRATIONS_DIRECTORY,
} from '../../../src/migrations.js';
import { createDisposableDatabaseFixture } from '../../../src/testing/postgres/disposable-database.js';

it('upgrades password accounts with two-factor off, isolated auth grants and cascading factor deletion', async () => {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_app', 'pertexo_migration', 'pertexo_maintenance'],
    databaseName: `pertexo_test_factor_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-factor-upgrade-'));
  let admin: Pool | undefined;
  try {
    await fixture.create();
    for (const name of await readdir(MIGRATIONS_DIRECTORY))
      if (name.endsWith('.sql') && name < '0040_')
        await copyFile(join(MIGRATIONS_DIRECTORY, name), join(directory, name));
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
    const id = randomUUID(),
      accountId = randomUUID();
    await admin.query(
      "insert into app.users(id,email,display_name,email_verified) values($1,'upgrade@example.test','Before upgrade',true)",
      [id],
    );
    await admin.query(
      "insert into app.auth_accounts(id,user_id,account_id,provider_id,password) values($1,$2,$3,'credential','preserved-password-hash')",
      [accountId, id, id],
    );
    expect(await migrateDatabase(migration)).toEqual([
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
      '0067_oauth2_connections.sql',
      '0068_connection_events_retention.sql',
      '0069_alert_dispatch_identity.sql',
      '0070_notice_window_from_core.sql',
      '0071_failure_alert_notice.sql',
      '0072_webhook_lookup_reports_standing.sql',
      '0073_attempt_foreign_key_indexes.sql',
      '0074_outbox_retention_and_row_signal.sql',
      '0075_schedule_failure_rests.sql',
      '0076_pending_task_limit.sql',
      '0077_run_data_token_scope.sql',
      '0078_workflow_update_token_scope.sql',
      '0079_workspace_data_token_scopes.sql',
      '0080_artifact_reference_locations.sql',
      '0081_serialize_capacity_provisioning.sql',
      '0082_complete_trigger_pause_state.sql',
      '0083_remove_test_probe.sql',
      '0084_remove_redundant_rls_policies.sql',
      '0085_execution_artifact_reference_coverage.sql',
      '0086_ordered_trigger_outcomes.sql',
      '0087_remove_trigger_outcome_fold.sql',
      '0088_repair_existing_workspace_capacity.sql',
      '0089_expose_unconfirmed_invitation_delivery.sql',
      '0090_bound_trigger_failure_evidence.sql',
      '0091_pending_trigger_success_order.sql',
      '0092_coordinated_event_retry_evidence.sql',
      '0093_schedule_retirement_storage.sql',
      '0094_webhook_ingress_counter_storage.sql',
      '0095_public_form_lookup_standing.sql',
      '0096_schedule_retirement_state.sql',
      '0097_error_workflow_delivery_repair.sql',
      '0098_stuck_work_candidate_pages.sql',
      '0099_notification_recovery_storage.sql',
      '0100_core_run_admission.sql',
      '0101_restore_timer_capacity_triggers.sql',
      '0102_reconcile_timer_capacity_counters.sql',
      '0103_preview_unclaimed_cleanup.sql',
      '0104_authoring_receipt_capacity.sql',
      '0105_escaped_receipt_labels.sql',
      '0106_session_security_integrity.sql',
    ]);
    expect(
      (
        await admin.query(
          'select two_factor_enabled from app.users where id=$1',
          [id],
        )
      ).rows,
    ).toEqual([{ two_factor_enabled: false }]);
    expect(
      (
        await admin.query(
          'select password from app.auth_accounts where id=$1',
          [accountId],
        )
      ).rows,
    ).toEqual([{ password: 'preserved-password-hash' }]);
    const privileges = await admin.query(
      "select has_table_privilege('pertexo_app','app.auth_two_factors','SELECT,INSERT,UPDATE,DELETE') app_access,has_table_privilege('pertexo_maintenance','app.auth_two_factors','SELECT') maintenance_read,has_column_privilege('pertexo_app','app.users','two_factor_enabled','UPDATE') enable,relrowsecurity,relforcerowsecurity from pg_class where oid='app.auth_two_factors'::regclass",
    );
    expect(privileges.rows).toEqual([
      {
        app_access: true,
        maintenance_read: false,
        enable: true,
        relrowsecurity: false,
        relforcerowsecurity: false,
      },
    ]);
    await admin.query(
      "insert into app.auth_two_factors(id,user_id,secret,backup_codes) values($1,$2,'sealed-secret','sealed-codes')",
      [randomUUID(), id],
    );
    expect(
      (
        await admin.query(
          'select verified,failed_verification_count,locked_until from app.auth_two_factors where user_id=$1',
          [id],
        )
      ).rows,
    ).toEqual([
      { verified: false, failed_verification_count: 0, locked_until: null },
    ]);
    await admin.query('delete from app.users where id=$1', [id]);
    expect(
      (
        await admin.query(
          'select id from app.auth_two_factors where user_id=$1',
          [id],
        )
      ).rows,
    ).toHaveLength(0);
  } finally {
    await admin?.end();
    await fixture.drop();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
