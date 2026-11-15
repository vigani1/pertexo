import { testStackSetting } from '../../../infrastructure/testing/test-stack.mjs';
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDisposableDatabaseFixture,
  migrateDatabase,
} from '@pertexo/database/testing';

import { inProcess } from './support/in-process.js';

const adminUrl = testStackSetting('DATABASE_ADMIN_URL');
const migrationUrl = testStackSetting('DATABASE_MIGRATION_URL');
const appUrl = testStackSetting('DATABASE_URL');
const databaseName = `pertexo_test_secrets_process_${randomUUID().replaceAll('-', '')}`;
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  databaseName,
  ownerRole: 'pertexo_owner',
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
});
const url = (base: string) => {
  const value = new URL(base);
  value.pathname = `/${databaseName}`;
  return value.toString();
};

beforeAll(async () => {
  await fixture.create();
  await migrateDatabase({
    connectionString: url(migrationUrl),
    ownerRole: 'pertexo_owner',
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
  });
}, 60_000);

afterAll(async () => {
  await fixture.drop();
}, 30_000);

describe('@pertexo/secrets/server as a built package', () => {
  it('lets a process queue and claim mail in a real database, then exit cleanly', async () => {
    const id = randomUUID();
    const outcome = await inProcess(
      `
      import { createSystemMailEnqueueStore, createSystemMailDeliveryStore } from '@pertexo/secrets/server';
      const config = {
        connectionString: process.env.MAIL_DATABASE_URL,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 5000,
        max: 1,
        ownerRole: 'pertexo_owner',
      };
      const enqueue = createSystemMailEnqueueStore(config);
      const deliver = createSystemMailDeliveryStore(config);
      await enqueue.enqueue({
        id: process.env.MAIL_ID,
        purpose: 'verification',
        expiresAt: new Date(Date.now() + 3600000),
        sealedPayload: { ciphertext: 'c', nonce: 'n', tag: 't', keyVersion: 'v1' },
      });
      const claims = await deliver.claim({ workerId: 'process-test', limit: 1 });
      await enqueue.close();
      await deliver.close();
      console.log(JSON.stringify(claims.map((claim) => claim.id)));
    `,
      { MAIL_DATABASE_URL: url(appUrl), MAIL_ID: id },
    );

    expect(outcome).toEqual([id]);
    const admin = new Pool({ connectionString: url(adminUrl), max: 1 });
    try {
      const row = await admin.query(
        'select status from app.system_mail_deliveries where id=$1',
        [id],
      );
      expect(row.rows).toEqual([{ status: 'outcome_unknown' }]);
    } finally {
      await admin.end();
    }
  });
});
