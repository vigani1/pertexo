import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../../src/migrations.js';
import { parseDatabaseConfig } from '../../../src/config.js';
import { createTwoFactorRecoveryStore } from '../../../src/identity/two-factor/recovery.repository.js';
import type { TwoFactorRecoveryStore } from '../../../src/identity/two-factor/contract.js';
import { createSystemMailDeliveryStore } from '../../../src/platform/mail/repository.js';
import type {
  SystemMailDeliveryStore,
  SystemMailInput,
} from '../../../src/platform/mail/contract.js';
import { createDisposableDatabaseFixture } from '../../support/postgres/disposable-database.js';

describe('privileged two-factor recovery with application grants', () => {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    databaseName: `pertexo_test_factor_support_${randomUUID().replaceAll('-', '')}`,
    connectRoles: ['pertexo_app', 'pertexo_migration', 'pertexo_maintenance'],
    ownerRole: 'pertexo_owner',
  });
  const closers: (() => Promise<void>)[] = [];
  let admin: Pool;
  let store: TwoFactorRecoveryStore;
  let delivery: SystemMailDeliveryStore;
  beforeAll(async () => {
    await fixture.create();
    await migrateDatabase({
      connectionString: fixture.databaseUrl(
        process.env.DATABASE_MIGRATION_URL ??
          'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/postgres',
      ),
      appRole: 'pertexo_app',
      maintenanceRole: 'pertexo_maintenance',
      ownerRole: 'pertexo_owner',
    });
    admin = new Pool({
      connectionString: fixture.databaseUrl(adminUrl),
      max: 1,
    });
    closers.push(() => admin.end());
    store = createTwoFactorRecoveryStore(
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(
          process.env.DATABASE_URL ??
            'postgresql://pertexo_app:pertexo-local-app@localhost:5432/postgres',
        ),
        max: 2,
      }),
    );
    closers.push(() => store.close());
    delivery = createSystemMailDeliveryStore(
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(
          process.env.DATABASE_URL ??
            'postgresql://pertexo_app:pertexo-local-app@localhost:5432/postgres',
        ),
        max: 1,
      }),
    );
    closers.push(() => delivery.close());
  }, 30_000);
  afterAll(async () => {
    try {
      await Promise.all(closers.map((close) => close()));
    } finally {
      await fixture.drop();
    }
  });
  async function person() {
    const id = randomUUID(),
      email = `${id}@example.test`;
    await admin.query(
      "insert into app.users(id,email,display_name,two_factor_enabled) values($1,$2,'Recovery Person',true)",
      [id, email],
    );
    await admin.query(
      "insert into app.auth_two_factors(id,user_id,secret,backup_codes,verified) values($1,$2,'opaque-authenticator-secret','opaque-backup-codes',true)",
      [randomUUID(), id],
    );
    return { id, email };
  }
  function notice(): SystemMailInput {
    return {
      id: randomUUID(),
      purpose: 'two_factor_disabled',
      expiresAt: new Date(Date.now() + 86_400_000),
      sealedPayload: {
        ciphertext: 'sealed-notice',
        nonce: 'nonce',
        tag: 'tag',
        keyVersion: 'v1',
      },
    };
  }
  it('lets one concurrent reset win, queues one notice, and leaves the factor bytes out of results', async () => {
    const user = await person();
    const prepared = notice();
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        store.disable(user.email, () => prepared),
      ),
    );
    expect(results.map((value) => value.status).sort()).toEqual([
      'already_off',
      'already_off',
      'disabled',
    ]);
    expect(JSON.stringify(results)).not.toContain('opaque');
    expect(
      (
        await admin.query(
          'select two_factor_enabled from app.users where id=$1',
          [user.id],
        )
      ).rows,
    ).toEqual([{ two_factor_enabled: false }]);
    expect(
      (
        await admin.query(
          'select id from app.auth_two_factors where user_id=$1',
          [user.id],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await admin.query(
          'select event_type from app.identity_security_audit_facts where user_id=$1',
          [user.id],
        )
      ).rows,
    ).toEqual([{ event_type: 'two_factor.operator_disabled' }]);
    const claims = await delivery.claim({
      workerId: 'factor-support-test',
      limit: 1,
    });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      id: prepared.id,
      purpose: prepared.purpose,
      sealedPayload: prepared.sealedPayload,
    });
  });
  it('rolls factor removal back if the security notice cannot be prepared', async () => {
    const user = await person();
    await expect(
      store.disable(user.email, () => {
        throw new Error('mail key unavailable');
      }),
    ).rejects.toThrow('mail key unavailable');
    expect(
      (
        await admin.query(
          'select two_factor_enabled from app.users where id=$1',
          [user.id],
        )
      ).rows,
    ).toEqual([{ two_factor_enabled: true }]);
    expect(
      (
        await admin.query(
          'select id from app.auth_two_factors where user_id=$1',
          [user.id],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await admin.query(
          'select id from app.identity_security_audit_facts where user_id=$1',
          [user.id],
        )
      ).rows,
    ).toEqual([]);
  });
  it('rolls factor removal back if its mail insert fails, and reports unknown accounts without preparing a notice', async () => {
    const user = await person();
    const prepared = notice();
    await admin.query(
      "insert into app.system_mail_deliveries(id,purpose,expires_at,payload_ciphertext,payload_nonce,payload_tag,payload_key_version) values($1,'two_factor_disabled',$2,'sealed','nonce','tag','v1')",
      [prepared.id, prepared.expiresAt],
    );
    await expect(
      store.disable(user.email, () => prepared),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'system_mail_deliveries_pkey',
    });
    expect(
      (
        await admin.query(
          'select two_factor_enabled from app.users where id=$1',
          [user.id],
        )
      ).rows,
    ).toEqual([{ two_factor_enabled: true }]);
    expect(
      (
        await admin.query(
          'select id from app.auth_two_factors where user_id=$1',
          [user.id],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await admin.query(
          'select id from app.identity_security_audit_facts where user_id=$1',
          [user.id],
        )
      ).rows,
    ).toEqual([]);
    const email = `${randomUUID()}@example.test`;
    expect(
      await store.disable(email, () => {
        throw new Error('must not prepare');
      }),
    ).toEqual({ status: 'not_found', email });
  });
});
