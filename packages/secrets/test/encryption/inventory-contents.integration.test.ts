import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDisposableDatabaseFixture,
  migrateDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';

import { createEncryptionKeyRepository } from '../../src/encryption/keys.repository.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const maintenanceUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';
const databaseName = `pertexo_test_key_contents_${randomUUID().replaceAll('-', '')}`;
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

const workspaceId = randomUUID();
const connectionId = randomUUID();
const secretVersionId = randomUUID();
const liveEvent = randomUUID();
const expiredEvent = randomUUID();
const PLAINTEXT_MARKER = 'stored-ciphertext-marker';

let admin!: Pool;

const repository = () =>
  createEncryptionKeyRepository(
    parseDatabaseConfig({ connectionString: url(maintenanceUrl), max: 1 }),
  );

async function readAll() {
  const keys = repository();
  try {
    const records = [];
    for await (const record of keys.read(AbortSignal.timeout(10_000)))
      records.push(record);
    return records;
  } finally {
    await keys.close();
  }
}

beforeAll(async () => {
  await fixture.create();
  await migrateDatabase({
    connectionString: url(migrationUrl),
    ownerRole: 'pertexo_owner',
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
  });
  admin = new Pool({ connectionString: url(adminUrl), max: 1 });
  const client = await admin.connect();
  try {
    // The inventory reads only these rows, not their parents.
    await client.query('set session_replication_role=replica');
    await client.query(
      `insert into app.connection_secret_versions
        (id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,
         ciphertext,nonce,auth_tag,created_by)
       values($1,$2,$3,'alias/fixture','d3JhcHBlZA',$4,repeat('A',16),repeat('A',22),$5)`,
      [
        secretVersionId,
        workspaceId,
        connectionId,
        PLAINTEXT_MARKER,
        randomUUID(),
      ],
    );
    for (const [id, expiresIn, hashLetter] of [
      [liveEvent, '1 hour', 'a'],
      [expiredEvent, '-1 hour', 'b'],
    ] as const)
      await client.query(
        `insert into app.webhook_test_events
          (id,workspace_id,workflow_id,node_id,created_by,endpoint_key_hash,binding,
           authentication,kms_key_reference,encrypted_data_key,ciphertext,nonce,
           auth_tag,created_at,expires_at)
         values($1,$2,$3,'webhook',$3,repeat($6,64),'{}','{}','alias/fixture','d3JhcHBlZA',
           $4,'nonce','tag',clock_timestamp()-interval '2 hours',
           clock_timestamp()+$5::interval)`,
        [
          id,
          workspaceId,
          randomUUID(),
          PLAINTEXT_MARKER,
          expiresIn,
          hashLetter,
        ],
      );
    await client.query('set session_replication_role=origin');
  } finally {
    client.release();
  }
}, 60_000);

afterAll(async () => {
  await admin.end();
  await fixture.drop();
}, 30_000);

describe('what the key inventory returns', () => {
  it('names each key and hands over only its wrapped form', async () => {
    const records = await readAll();
    const connection = records.find(
      (record) => record.secretVersionId === secretVersionId,
    );

    expect(connection).toEqual({
      kind: 'connection',
      workspaceId,
      resourceId: connectionId,
      secretVersionId,
      keyReference: 'alias/fixture',
      encryptedDataKey: 'd3JhcHBlZA',
    });
    expect(JSON.stringify(records)).not.toContain(PLAINTEXT_MARKER);
  });

  it('skips an expired webhook test event and keeps a live one', async () => {
    const ids = (await readAll()).map((record) => record.secretVersionId);

    expect(ids).toContain(liveEvent);
    expect(ids).not.toContain(expiredEvent);
  });

  it('raises a cancellation as an AbortError', async () => {
    const keys = repository();
    const controller = new AbortController();
    try {
      const reading = keys.read(controller.signal)[Symbol.asyncIterator]();
      await reading.next();
      controller.abort();

      await expect(reading.next()).rejects.toMatchObject({
        name: 'AbortError',
      });
    } finally {
      await keys.close();
    }
  });

  it('says only that the inventory is unavailable when the database is damaged', async () => {
    await admin.query(
      'alter table app.connection_secret_versions rename to connection_secret_versions_moved',
    );
    try {
      const failure = await readAll().catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        'Encryption key inventory is unavailable',
      );
      expect((failure as Error).cause).toBeUndefined();
    } finally {
      await admin.query(
        'alter table app.connection_secret_versions_moved rename to connection_secret_versions',
      );
    }
  });
});
