import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../../src/migrations.js';
import { createSystemMailDeliveryStore } from '../../src/platform/mail/repository.js';
import { parseDatabaseConfig } from '../../src/config.js';
import { createDisposableDatabaseFixture } from '../support/postgres/disposable-database.js';

it('preserves mail identities through the rename and old messages through subsequent upgrades', async () => {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_app', 'pertexo_migration', 'pertexo_maintenance'],
    databaseName: `pertexo_test_mail_upgrade_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-mail-upgrade-'));
  let admin: Pool | undefined;
  let worker: ReturnType<typeof createSystemMailDeliveryStore> | undefined;
  try {
    await fixture.create();
    for (const name of await readdir(MIGRATIONS_DIRECTORY))
      if (/^00(?:0[0-9]|1[0-6])_.*\.sql$/u.test(name))
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
    const id = randomUUID();
    await admin.query(
      "insert into app.authentication_mail_deliveries(id,purpose,expires_at,payload_ciphertext,payload_nonce,payload_tag,payload_key_version) values($1,'workspace_notice',clock_timestamp()+interval '1 day','preserved-ciphertext','nonce','tag','old-key')",
      [id],
    );
    const row = await admin.query(
      'select * from app.authentication_mail_deliveries where id=$1',
      [id],
    );
    const inspector = admin;
    const catalog = async (table: string) => ({
      relation: (
        await inspector.query(
          'select oid,relowner,relacl,relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass',
          [table],
        )
      ).rows,
      columns: (
        await inspector.query(
          'select attnum,attacl from pg_attribute where attrelid=$1::regclass and attnum>0 order by attnum',
          [table],
        )
      ).rows,
      indexes: (
        await inspector.query(
          'select indexrelid from pg_index where indrelid=$1::regclass order by indexrelid',
          [table],
        )
      ).rows,
      constraints: (
        await inspector.query(
          'select oid,contype,confrelid from pg_constraint where conrelid=$1::regclass or confrelid=$1::regclass order by oid',
          [table],
        )
      ).rows,
    });
    const before = await catalog('app.authentication_mail_deliveries');
    await copyFile(
      join(MIGRATIONS_DIRECTORY, '0017_system_mail_deliveries.sql'),
      join(directory, '0017_system_mail_deliveries.sql'),
    );
    expect(await migrateDatabase(migration, directory)).toEqual([
      '0017_system_mail_deliveries.sql',
    ]);
    expect(await catalog('app.system_mail_deliveries')).toEqual(before);
    expect(await migrateDatabase(migration)).toEqual([
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
    ]);
    const after = await catalog('app.system_mail_deliveries');
    expect(after.relation).toEqual(before.relation);
    expect(after.columns).toEqual(before.columns);
    expect(after.indexes).toEqual(before.indexes);
    expect(
      (
        await admin.query(
          'select * from app.system_mail_deliveries where id=$1',
          [id],
        )
      ).rows,
    ).toEqual(row.rows);
    expect(
      (
        await admin.query(
          "select to_regclass('app.authentication_mail_deliveries') old",
        )
      ).rows,
    ).toEqual([{ old: null }]);
    expect(
      (
        await admin.query(
          "select has_table_privilege('pertexo_app','app.system_mail_deliveries','INSERT') enqueue,has_column_privilege('pertexo_app','app.system_mail_deliveries','status','UPDATE') settle,has_column_privilege('pertexo_app','app.system_mail_deliveries','purpose','UPDATE') rewrite,has_table_privilege('pertexo_maintenance','app.system_mail_deliveries','DELETE') retention",
        )
      ).rows,
    ).toEqual([
      { enqueue: true, settle: true, rewrite: false, retention: true },
    ]);
    worker = createSystemMailDeliveryStore(
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(
          process.env.DATABASE_URL ??
            'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
        ),
        max: 1,
      }),
    );
    const claims = await worker.claim({ workerId: 'upgrade-proof', limit: 1 });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      id,
      purpose: 'workspace_notice',
      sealedPayload: {
        ciphertext: 'preserved-ciphertext',
        nonce: 'nonce',
        tag: 'tag',
        keyVersion: 'old-key',
      },
    });
    expect(await migrateDatabase(migration)).toEqual([]);
  } finally {
    await worker?.close();
    await admin?.end();
    await fixture.drop();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
