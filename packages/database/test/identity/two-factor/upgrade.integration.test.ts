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
import { createDisposableDatabaseFixture } from '../../support/postgres/disposable-database.js';

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
