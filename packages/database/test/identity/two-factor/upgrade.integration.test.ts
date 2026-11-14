import { testStackSetting } from '../../../../../infrastructure/testing/test-stack.mjs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { migrateDatabase } from '../../../src/migrations/migrate-database.js';
import { createDisposableDatabaseFixture } from '../../../src/testing/postgres/disposable-database.js';

it('upgrades password accounts with two-factor off, isolated auth grants and cascading factor deletion', async () => {
  const adminUrl = testStackSetting('DATABASE_ADMIN_URL');
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_app', 'pertexo_migration', 'pertexo_maintenance'],
    databaseName: `pertexo_test_factor_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });

  let admin: Pool | undefined;
  try {
    await fixture.create();

    const migration = {
      appRole: 'pertexo_app',
      ownerRole: 'pertexo_owner',
      maintenanceRole: 'pertexo_maintenance',
      connectionString: fixture.databaseUrl(
        testStackSetting('DATABASE_MIGRATION_URL'),
      ),
    };
    await migrateDatabase(migration);
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
  }
}, 30_000);
