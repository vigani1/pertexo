import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createAuthenticationMailEnqueueStore,
  type DatabaseConfig,
} from '../src/api.js';
import { createAuthenticationMailDeliveryStore } from '../src/execution.js';
import { migrateDatabase } from '../src/migrations.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerBaseUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const maintenanceBaseUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const database = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: [
    'pertexo_migration',
    'pertexo_api',
    'pertexo_worker',
    'pertexo_maintenance',
  ],
  databaseName: `pertexo_test_auth_mail_${randomUUID().replaceAll('-', '')}`,
  ownerRole: 'pertexo_owner',
});
const databaseConfig = (connectionString: string): DatabaseConfig => ({
  connectionString,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
  max: 2,
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
});

beforeAll(async () => {
  await database.create();
  await migrateDatabase({
    apiRuntimeRole: 'pertexo_api',
    connectionString: database.databaseUrl(migrationBaseUrl),
    dispatcherRole: 'pertexo_dispatcher',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
    maintenanceRole: 'pertexo_maintenance',
    operatorRole: 'pertexo_operator',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  });
}, 30_000);
afterAll(database.drop);

describe('durable authentication mail', () => {
  it('enforces least privilege, exact retries, lease fencing and ciphertext cleanup', async () => {
    const api = createAuthenticationMailEnqueueStore(
      databaseConfig(database.databaseUrl(apiBaseUrl)),
    );
    const worker = createAuthenticationMailDeliveryStore(
      databaseConfig(database.databaseUrl(workerBaseUrl)),
    );
    const id = randomUUID();
    try {
      await api.enqueue({
        id,
        purpose: 'password_reset',
        expiresAt: new Date(Date.now() + 60_000),
        sealedPayload: {
          ciphertext: 'sealed-without-recipient-or-url',
          nonce: 'nonce',
          tag: 'tag',
          keyVersion: 'v1',
        },
      });

      const [first, competing] = await Promise.all([
        worker.claim({ workerId: 'mail:a', limit: 1 }),
        worker.claim({ workerId: 'mail:b', limit: 1 }),
      ]);
      expect([...first, ...competing]).toHaveLength(1);
      const claim = [...first, ...competing][0];
      if (claim === undefined) throw new Error('Mail claim was not returned');
      expect(claim.sealedPayload.ciphertext).toBe(
        'sealed-without-recipient-or-url',
      );
      await expect(
        worker.settle({
          id,
          leaseToken: randomUUID(),
          leaseGeneration: claim.leaseGeneration,
          outcome: 'submitted',
        }),
      ).resolves.toBe(false);
      await expect(
        worker.settle({
          id,
          leaseToken: claim.leaseToken,
          leaseGeneration: claim.leaseGeneration,
          outcome: 'retry',
          retryAt: new Date(),
          failureCode: 'delivery.outcome_unknown',
        }),
      ).resolves.toBe(true);

      const retry = (await worker.claim({ workerId: 'mail:a', limit: 1 }))[0];
      expect(retry?.id).toBe(id);
      expect(retry?.sealedPayload).toEqual(claim.sealedPayload);
      if (retry === undefined) throw new Error('Mail retry was not returned');
      await expect(
        worker.settle({
          id,
          leaseToken: retry.leaseToken,
          leaseGeneration: retry.leaseGeneration,
          outcome: 'submitted',
          providerReference: 'provider-reference',
        }),
      ).resolves.toBe(true);

      const owner = new Pool({
        connectionString: database.databaseUrl(adminUrl),
        max: 1,
      });
      try {
        const stored = await owner.query<{
          status: string;
          payload_ciphertext: string | null;
          attempt_count: number;
        }>(
          `select status,payload_ciphertext,attempt_count
             from app.authentication_mail_deliveries where id=$1`,
          [id],
        );
        expect(stored.rows[0]).toEqual({
          status: 'submitted',
          payload_ciphertext: null,
          attempt_count: 2,
        });
      } finally {
        await owner.end();
      }

      const apiPool = new Pool({
        connectionString: database.databaseUrl(apiBaseUrl),
        max: 1,
      });
      const workerPool = new Pool({
        connectionString: database.databaseUrl(workerBaseUrl),
        max: 1,
      });
      try {
        await expect(
          apiPool.query('select * from app.authentication_mail_deliveries'),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          workerPool.query(
            `select app.enqueue_authentication_mail($1,'verification',clock_timestamp()+interval '1 hour','x','n','t','v1')`,
            [randomUUID()],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await Promise.all([apiPool.end(), workerPool.end()]);
      }
    } finally {
      await Promise.all([api.close(), worker.close()]);
    }
  });

  it('expires abandoned commands in bounded pages and reconciles exhausted attempts', async () => {
    const owner = new Pool({
      connectionString: database.databaseUrl(adminUrl),
      max: 1,
    });
    const maintenance = new Pool({
      connectionString: database.databaseUrl(maintenanceBaseUrl),
      max: 1,
    });
    const worker = createAuthenticationMailDeliveryStore(
      databaseConfig(database.databaseUrl(workerBaseUrl)),
    );
    const expiredIds: string[] = Array.from({ length: 15 }, () => randomUUID());
    const exhaustedId = randomUUID();
    try {
      for (const id of expiredIds) {
        await owner.query(
          `insert into app.authentication_mail_deliveries
             (id,purpose,expires_at,created_at,payload_ciphertext,
              payload_nonce,payload_tag,payload_key_version)
           values($1,'verification',clock_timestamp()-interval '1 hour',
                  clock_timestamp()-interval '2 hours','sealed','nonce','tag','v1')`,
          [id],
        );
      }
      await owner.query(
        `insert into app.authentication_mail_deliveries
           (id,purpose,expires_at,attempt_count,payload_ciphertext,
            payload_nonce,payload_tag,payload_key_version)
         values($1,'password_reset',clock_timestamp()+interval '1 hour',
                12,'sealed','nonce','tag','v1')`,
        [exhaustedId],
      );

      await worker.claim({ workerId: 'mail:bounded', limit: 1 });
      const before = await owner.query<{ count: string }>(
        `select count(*) from app.authentication_mail_deliveries
          where id=any($1::uuid[]) and status='queued'`,
        [expiredIds],
      );
      expect(before.rows[0]?.count).toBe('15');

      const expiredCounts: number[] = [];
      for (let page = 0; page < 3; page += 1) {
        const result = await maintenance.query<{ expired: number }>(
          `select expired from app.prune_authentication_mail(7)`,
        );
        expiredCounts.push(result.rows[0]?.expired ?? -1);
      }
      expect(expiredCounts).toEqual([7, 7, 2]);
      const after = await owner.query<{
        id: string;
        status: string;
        payload_ciphertext: string | null;
      }>(
        `select id,status,payload_ciphertext
           from app.authentication_mail_deliveries
          where id=any($1::uuid[]) or id=$2`,
        [expiredIds, exhaustedId],
      );
      expect(after.rows).toHaveLength(16);
      expect(
        after.rows
          .filter((row) => expiredIds.includes(row.id))
          .every(
            (row) =>
              row.status === 'expired' && row.payload_ciphertext === null,
          ),
      ).toBe(true);
      expect(after.rows.find((row) => row.id === exhaustedId)).toMatchObject({
        status: 'reconciliation_required',
        payload_ciphertext: null,
      });
    } finally {
      await Promise.all([owner.end(), maintenance.end(), worker.close()]);
    }
  });
});
