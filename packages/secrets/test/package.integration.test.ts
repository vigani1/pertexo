import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDisposableDatabaseFixture,
  migrateDatabase,
} from '@pertexo/database/testing';

const execute = promisify(execFile);
const packageDirectory = fileURLToPath(new URL('..', import.meta.url));

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const appUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
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

/** Runs in its own process, by package name, so only the built output can answer. */
async function inProcess(script: string, environment = {}) {
  const { stdout } = await execute(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: packageDirectory,
      env: { ...process.env, ...environment },
      timeout: 20_000,
    },
  );
  return JSON.parse(stdout) as unknown;
}

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
  it('names the entry point it promises', async () => {
    const names = await inProcess(`
      const entry = await import('@pertexo/secrets/server');
      console.log(JSON.stringify(Object.keys(entry).sort()));
    `);

    expect(names).toEqual([
      'authenticationMailAssociatedData',
      'createEncryptionKeyRepository',
      'createSystemMailDeliveryStore',
      'createSystemMailEnqueueStore',
      'insertSystemMail',
    ]);
  });

  it('has no root entry point', async () => {
    await expect(
      inProcess(`await import('@pertexo/secrets');`),
    ).rejects.toThrow(/ERR_PACKAGE_PATH_NOT_EXPORTED|No "exports" main/u);
  });

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

  it('took its names out of the database platform entry point', async () => {
    const names = (await inProcess(`
      const entry = await import('@pertexo/database/platform');
      console.log(JSON.stringify(Object.keys(entry)));
    `)) as readonly string[];

    for (const moved of [
      'authenticationMailAssociatedData',
      'createEncryptionKeyRepository',
      'createSystemMailDeliveryStore',
      'createSystemMailEnqueueStore',
      'insertSystemMail',
    ])
      expect(names).not.toContain(moved);
  });
});
