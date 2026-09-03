import { randomUUID } from 'node:crypto';

import { count, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  consumeInboxMessage,
  InboxChecksumMismatchError,
  InboxReceiptUnavailableError,
} from '../src/inbox.js';
import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../src/outbox.js';
import { inboxReceipts, transportSecurityAuditFacts } from '../src/schema.js';
import { createTransportTestEnvironment } from './support/transport.integration.support.js';

const transport = createTransportTestEnvironment();
const {
  apiDatabase,
  checksumA,
  checksumB,
  hasPostgresCode,
  migrationUrl,
  workerDatabase,
  workspaceA,
  workspaceB,
} = transport;

beforeAll(transport.initialize);
beforeEach(transport.reset);
afterAll(transport.close);

describe('transactional inbox duplicate proof', () => {
  it('grants serving roles only the receipt completion update', async () => {
    const pool = new Pool({ connectionString: migrationUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      const privileges = await client.query<{
        api_completed_at_update: boolean;
        api_table_update: boolean;
        worker_completed_at_update: boolean;
        worker_table_update: boolean;
      }>(`
        select
          has_table_privilege('pertexo_api', table_class.oid, 'UPDATE')
            as api_table_update,
          has_column_privilege(
            'pertexo_api', table_class.oid, 'completed_at', 'UPDATE'
          ) as api_completed_at_update,
          has_table_privilege('pertexo_worker', table_class.oid, 'UPDATE')
            as worker_table_update,
          has_column_privilege(
            'pertexo_worker', table_class.oid, 'completed_at', 'UPDATE'
          ) as worker_completed_at_update
        from pg_class table_class
        where table_class.oid = 'app.inbox_receipts'::regclass
      `);
      expect(privileges.rows).toEqual([
        {
          api_completed_at_update: true,
          api_table_update: false,
          worker_completed_at_update: true,
          worker_table_update: false,
        },
      ]);
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  });

  it.each([
    ['API', apiDatabase],
    ['worker', workerDatabase],
  ])(
    'allows the %s role to complete receipts but not rewrite immutable identity',
    async (_role, selectedDatabase) => {
      const messageId = randomUUID();
      await consumeInboxMessage(
        selectedDatabase,
        workspaceA,
        {
          consumerName: 'least-privilege-proof',
          messageId,
          payloadChecksum: checksumA,
        },
        () => Promise.resolve(undefined),
      );

      await expect(
        selectedDatabase.withWorkspace(workspaceA, ({ db }) =>
          db
            .update(inboxReceipts)
            .set({ payloadChecksum: checksumB })
            .where(eq(inboxReceipts.messageId, messageId)),
        ),
      ).rejects.toSatisfy(hasPostgresCode('42501'));
    },
  );

  it('atomically records one attempt, event, usage charge, and provider intent', async () => {
    const messageId = randomUUID();
    const logicalAttemptId = randomUUID();
    const providerOutboxId = randomUUID();
    const providerPayload = {
      logicalAttemptId,
      providerIntentId: randomUUID(),
      schemaVersion: 1,
    };
    const providerChecksum = canonicalOutboxPayloadChecksum(providerPayload);
    let callbacks = 0;
    const consume = () =>
      consumeInboxMessage(
        workerDatabase,
        workspaceA,
        { consumerName: 'phase0-proof', messageId, payloadChecksum: checksumA },
        async (transaction) => {
          const { db, workspaceId } = transaction;
          callbacks += 1;
          await db.execute(sql`
            insert into app.queue_duplicate_probe_attempts
              (id, workspace_id, logical_attempt_id)
            values (${randomUUID()}, ${workspaceId}, ${logicalAttemptId})
          `);
          await db.execute(sql`
            insert into app.queue_duplicate_probe_events
              (id, workspace_id, logical_attempt_id, sequence)
            values (${randomUUID()}, ${workspaceId}, ${logicalAttemptId}, 1)
          `);
          await db.execute(sql`
            insert into app.queue_duplicate_probe_usage
              (id, workspace_id, idempotency_key, quantity)
            values (${randomUUID()}, ${workspaceId}, ${`usage:${logicalAttemptId}`}, 1)
          `);
          await insertOutboxEvent(transaction, {
            id: providerOutboxId,
            jobName: 'dispatch-provider-request',
            schemaVersion: 1,
            aggregateType: 'provider-intent',
            aggregateId: providerPayload.providerIntentId,
            payload: providerPayload,
            payloadChecksum: providerChecksum,
          });
          await db.execute(sql`
            insert into app.queue_duplicate_probe_provider_intents
              (
                id,
                workspace_id,
                logical_attempt_id,
                outbox_event_id,
                idempotency_key
              )
            values (
              ${providerPayload.providerIntentId},
              ${workspaceId},
              ${logicalAttemptId},
              ${providerOutboxId},
              ${`provider:${logicalAttemptId}`}
            )
          `);
          return logicalAttemptId;
        },
      );

    const [first, second] = await Promise.all([consume(), consume()]);
    expect([first.status, second.status].sort()).toEqual([
      'duplicate',
      'processed',
    ]);
    expect(callbacks).toBe(1);

    let providerCallbacks = 0;
    const consumeProvider = () =>
      consumeInboxMessage(
        workerDatabase,
        workspaceA,
        {
          consumerName: 'phase0-provider-proof',
          messageId: providerOutboxId,
          payloadChecksum: providerChecksum,
        },
        async ({ db }) => {
          providerCallbacks += 1;
          await db.execute(sql`
            update app.queue_duplicate_probe_provider_intents
            set outcome = 'accepted', completed_at = clock_timestamp()
            where id = ${providerPayload.providerIntentId}
              and outcome = 'pending'
          `);
        },
      );
    const [providerFirst, providerSecond] = await Promise.all([
      consumeProvider(),
      consumeProvider(),
    ]);
    expect([providerFirst.status, providerSecond.status].sort()).toEqual([
      'duplicate',
      'processed',
    ]);
    expect(providerCallbacks).toBe(1);

    await workerDatabase.withWorkspace(workspaceA, async ({ db }) => {
      const tableNames = [
        'queue_duplicate_probe_attempts',
        'queue_duplicate_probe_events',
        'queue_duplicate_probe_usage',
        'queue_duplicate_probe_provider_intents',
      ];
      for (const tableName of tableNames) {
        const result = await db.execute(
          sql.raw(`select count(*)::integer as count from app.${tableName}`),
        );
        expect(result.rows[0]).toEqual({ count: 1 });
      }
      const intent = await db.execute(sql`
        select outcome, completed_at is not null as completed
        from app.queue_duplicate_probe_provider_intents
        where id = ${providerPayload.providerIntentId}
      `);
      expect(intent.rows).toEqual([{ outcome: 'accepted', completed: true }]);
    });
  });

  it('rejects a changed checksum and an invisible cross-workspace receipt', async () => {
    const messageId = randomUUID();
    await consumeInboxMessage(
      workerDatabase,
      workspaceA,
      { consumerName: 'checksum-proof', messageId, payloadChecksum: checksumA },
      () => Promise.resolve(undefined),
    );
    await expect(
      consumeInboxMessage(
        workerDatabase,
        workspaceA,
        {
          consumerName: 'checksum-proof',
          messageId,
          payloadChecksum: checksumB,
        },
        () => Promise.resolve(undefined),
      ),
    ).rejects.toBeInstanceOf(InboxChecksumMismatchError);
    await workerDatabase.withWorkspace(workspaceA, async ({ db }) => {
      const facts = await db
        .select({
          consumerName: transportSecurityAuditFacts.consumerName,
          factType: transportSecurityAuditFacts.factType,
          messageId: transportSecurityAuditFacts.messageId,
        })
        .from(transportSecurityAuditFacts)
        .where(eq(transportSecurityAuditFacts.messageId, messageId));
      expect(facts).toEqual([
        {
          consumerName: 'checksum-proof',
          factType: 'inbox_checksum_mismatch',
          messageId,
        },
      ]);
    });
    await expect(
      consumeInboxMessage(
        workerDatabase,
        workspaceB,
        {
          consumerName: 'checksum-proof',
          messageId,
          payloadChecksum: checksumA,
        },
        () => Promise.resolve(undefined),
      ),
    ).rejects.toBeInstanceOf(InboxReceiptUnavailableError);
  });

  it('rolls the receipt and business mutation back together', async () => {
    const messageId = randomUUID();
    const logicalAttemptId = randomUUID();
    await expect(
      consumeInboxMessage(
        workerDatabase,
        workspaceA,
        {
          consumerName: 'rollback-proof',
          messageId,
          payloadChecksum: checksumA,
        },
        async ({ db, workspaceId }) => {
          await db.execute(sql`
            insert into app.queue_duplicate_probe_attempts
              (id, workspace_id, logical_attempt_id)
            values (${randomUUID()}, ${workspaceId}, ${logicalAttemptId})
          `);
          throw new Error('injected failure');
        },
      ),
    ).rejects.toThrow('injected failure');

    await expect(
      consumeInboxMessage(
        workerDatabase,
        workspaceA,
        {
          consumerName: 'rollback-proof',
          messageId,
          payloadChecksum: checksumA,
        },
        () => Promise.resolve('recovered'),
      ),
    ).resolves.toEqual({ status: 'processed', value: 'recovered' });
  });

  it('stores completed receipts only in the active workspace', async () => {
    await consumeInboxMessage(
      workerDatabase,
      workspaceA,
      {
        consumerName: 'workspace-proof',
        messageId: randomUUID(),
        payloadChecksum: checksumA,
      },
      () => Promise.resolve(undefined),
    );
    const receipts = await workerDatabase.withWorkspace(
      workspaceA,
      async ({ db }) => db.select({ count: count() }).from(inboxReceipts),
    );
    expect(receipts[0]?.count).toBeGreaterThan(0);
  });
});
