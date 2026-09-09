import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createWorkspaceDatabase } from '../src/database.js';
import { consumeInboxMessage } from '../src/execution/inbox.js';
import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../src/execution/outbox.js';
import { migrateDatabase } from '../src/migrations.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const databaseName = `pertexo_test_inbox_cancellation_${randomUUID().replaceAll('-', '')}`;
const withDatabase = (baseUrl: string) => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};
const migrationUrl = withDatabase(migrationBaseUrl);
const workerUrl = withDatabase(
  process.env.DATABASE_WORKER_URL ??
    'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo',
);
const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: migrationUrl,
  dispatcherRole: 'pertexo_dispatcher',
  maintenanceRole: 'pertexo_maintenance',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;
const workspaceId = randomUUID();
const userId = randomUUID();
const checksum = createHash('sha256').update('inbox-cancel').digest('hex');
const workerDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: workerUrl, max: 2 }),
);
let owner: Pool | undefined;

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,
       pertexo_api,pertexo_worker,pertexo_dispatcher,pertexo_maintenance,
       pertexo_lifecycle_command,pertexo_operator`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase(migrationConfig);
  owner = new Pool({ connectionString: migrationUrl, max: 1 });
  await owner.query('begin');
  try {
    await owner.query('set local role pertexo_owner');
    await owner.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Inbox cancellation owner')",
      [userId, `${userId}@example.test`],
    );
    await owner.query(
      "insert into app.workspaces(id,name,slug,created_by) values($1,'Inbox cancellation',$2,$3)",
      [workspaceId, `inbox-cancellation-${workspaceId}`, userId],
    );
    await owner.query('commit');
  } catch (error: unknown) {
    await owner.query('rollback').catch(() => undefined);
    throw error;
  }
});

afterAll(async () => {
  await workerDatabase.close();
  await owner?.end();
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('inbox PostgreSQL cancellation', () => {
  it('rolls back receipt and business state on abort but preserves an earlier commit', async () => {
    if (owner === undefined) throw new Error('Owner pool unavailable');
    const messageId = randomUUID();
    const outboxId = randomUUID();
    const aggregateId = randomUUID();
    const payload = { aggregateId, outboxEventId: outboxId, schemaVersion: 1 };
    const controller = new AbortController();
    const queryStarted = Promise.withResolvers<undefined>();
    const consuming = consumeInboxMessage(
      workerDatabase,
      workspaceId,
      {
        consumerName: 'inbox-cancel-proof',
        messageId,
        payloadChecksum: checksum,
      },
      async (transaction) => {
        await insertOutboxEvent(transaction, {
          aggregateId,
          aggregateType: 'inbox-cancel-proof',
          id: outboxId,
          jobName: 'inbox-cancel-proof',
          payload,
          payloadChecksum: canonicalOutboxPayloadChecksum(payload),
          schemaVersion: 1,
        });
        queryStarted.resolve(undefined);
        await transaction.db.execute(sql`select pg_sleep(30)`);
      },
      { signal: controller.signal },
    );
    await queryStarted.promise;
    controller.abort(new Error('cancel inbox transaction'));
    await expect(consuming).rejects.toMatchObject({ name: 'AbortError' });

    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      const rolledBack = await owner.query<{ inbox: number; outbox: number }>(
        `select
           (select count(*)::integer from app.inbox_receipts
             where consumer_name='inbox-cancel-proof' and message_id=$1) inbox,
           (select count(*)::integer from app.outbox_events where id=$2) outbox`,
        [messageId, outboxId],
      );
      expect(rolledBack.rows).toEqual([{ inbox: 0, outbox: 0 }]);
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }

    const commitController = new AbortController();
    const committed = await consumeInboxMessage(
      workerDatabase,
      workspaceId,
      {
        consumerName: 'inbox-cancel-proof',
        messageId,
        payloadChecksum: checksum,
      },
      () => Promise.resolve('committed'),
      { signal: commitController.signal },
    );
    expect(committed).toEqual({ status: 'processed', value: 'committed' });
    commitController.abort(new Error('commit is already authoritative'));
    await expect(
      consumeInboxMessage(
        workerDatabase,
        workspaceId,
        {
          consumerName: 'inbox-cancel-proof',
          messageId,
          payloadChecksum: checksum,
        },
        () => Promise.reject(new Error('duplicate operation ran')),
      ),
    ).resolves.toEqual({ status: 'duplicate' });
  });
});
