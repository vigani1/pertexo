import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { count, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createWorkspaceDatabase } from '../src/database.js';
import { createOutboxDispatcherDatabase } from '../src/dispatcher.js';
import {
  createOperatorCommandDatabase,
  OperatorCommandConflictError,
} from '../src/operator-commands.js';
import {
  consumeInboxMessage,
  InboxChecksumMismatchError,
  InboxReceiptUnavailableError,
} from '../src/inbox.js';
import { migrateDatabase } from '../src/migrations.js';
import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../src/outbox.js';
import {
  inboxReceipts,
  auditEvents,
  outboxEvents,
  transportSecurityAuditFacts,
} from '../src/schema.js';

const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const dispatcherUrl =
  process.env.DATABASE_DISPATCHER_URL ??
  'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo';
const operatorUrl =
  process.env.DATABASE_OPERATOR_URL ??
  'postgresql://pertexo_operator:pertexo-local-operator@localhost:5432/pertexo';

const workspaceA = randomUUID();
const workspaceB = randomUUID();
const fixtureUserId = randomUUID();
const checksumA = createHash('sha256').update('payload-a').digest('hex');
const checksumB = createHash('sha256').update('payload-b').digest('hex');
const enabledJobNames = Object.freeze(['phase0-duplicate-proof']);

const apiDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
);
const workerDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: workerUrl, max: 4 }),
);
const dispatcher = createOutboxDispatcherDatabase(
  parseDatabaseConfig({ connectionString: dispatcherUrl, max: 2 }),
);
const operator = createOperatorCommandDatabase(
  parseDatabaseConfig({ connectionString: operatorUrl, max: 1 }),
);
const operatorReplica = createOperatorCommandDatabase(
  parseDatabaseConfig({ connectionString: operatorUrl, max: 1 }),
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

function hasPostgresCode(expectedCode: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current = error;
    while (current instanceof Error) {
      if ('code' in current && current.code === expectedCode) return true;
      current = current.cause;
    }
    return false;
  };
}

async function applyProofFixture(): Promise<void> {
  const source = await readFile(
    new URL('./fixtures/queue-duplicate-proof.sql', import.meta.url),
    'utf8',
  );
  const fixture = source
    .replaceAll('{{api_runtime_role}}', 'pertexo_api')
    .replaceAll('{{worker_runtime_role}}', 'pertexo_worker');
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(fixture);
    await client.query(
      `insert into app.users(id,email,display_name) values($1,$2,'Transport fixture')
       on conflict(id) do nothing`,
      [fixtureUserId, `transport-${fixtureUserId}@example.test`],
    );
    await client.query(
      `insert into app.workspaces(id,name,slug,created_by)
       values($1,'Transport A',$3,$2),($4,'Transport B',$5,$2)
       on conflict(id) do nothing`,
      [
        workspaceA,
        fixtureUserId,
        `transport-a-${workspaceA}`,
        workspaceB,
        `transport-b-${workspaceB}`,
      ],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function resetTransportFixture(): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(`
      truncate table
        app.transport_security_audit_facts,
        app.operator_run_replay_requests,
        app.operator_maintenance_rerun_requests,
        app.operator_commands,
        app.audit_events,
        app.inbox_receipts,
        app.workflow_run_active_admissions,
        app.outbox_events,
        app.queue_duplicate_probe_attempts,
        app.queue_duplicate_probe_events,
        app.queue_duplicate_probe_usage,
        app.queue_duplicate_probe_provider_effects,
        app.queue_duplicate_probe_provider_intents,
        app.queue_duplicate_probe_acceptances
    `);
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function expireLease(id: string): Promise<void> {
  const pool = new Pool({ connectionString: dispatcherUrl, max: 1 });
  try {
    await pool.query(
      `update app.outbox_events set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`,
      [id],
    );
  } finally {
    await pool.end();
  }
}

function outboxInput(id: string = randomUUID()) {
  const payload = { probeId: randomUUID(), schemaVersion: 1 };
  return {
    id,
    jobName: 'phase0-duplicate-proof',
    schemaVersion: 1,
    aggregateType: 'queue-proof',
    aggregateId: randomUUID(),
    payload,
    payloadChecksum: canonicalOutboxPayloadChecksum(payload),
  } as const;
}

beforeAll(async () => {
  await migrateDatabase(migrationConfig);
  await applyProofFixture();
});

beforeEach(resetTransportFixture);

afterAll(async () => {
  await Promise.all([
    apiDatabase.close(),
    workerDatabase.close(),
    dispatcher.close(),
    operator.close(),
    operatorReplica.close(),
  ]);
});

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
