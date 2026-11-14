import { testStackSetting } from '../../../../infrastructure/testing/test-stack.mjs';
import {
  createDisposableDatabaseFixture,
  migrateDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { createSystemMailDeliveryStore } from '../../src/mail/system-mail.store.js';

it('claims sealed mail payloads from the baseline with narrow enqueue, settle and retention privileges', async () => {
  const adminUrl = testStackSetting('DATABASE_ADMIN_URL');
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_app', 'pertexo_migration', 'pertexo_maintenance'],
    databaseName: `pertexo_test_mail_upgrade_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });

  let admin: Pool | undefined;
  let worker: ReturnType<typeof createSystemMailDeliveryStore> | undefined;
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
    const id = randomUUID();
    await admin.query(
      "insert into app.system_mail_deliveries(id,purpose,expires_at,payload_ciphertext,payload_nonce,payload_tag,payload_key_version) values($1,'workspace_notice',clock_timestamp()+interval '1 day','preserved-ciphertext','nonce','tag','old-key')",
      [id],
    );
    const row = await admin.query<Record<string, unknown>>(
      'select * from app.system_mail_deliveries where id=$1',
      [id],
    );
    expect(row.rows).toEqual([
      expect.objectContaining({ id, had_uncertain_attempt: false }),
    ]);
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
        connectionString: fixture.databaseUrl(testStackSetting('DATABASE_URL')),
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
  }
}, 60000);
