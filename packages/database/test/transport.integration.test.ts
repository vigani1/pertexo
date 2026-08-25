import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { count, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createWorkspaceDatabase } from '../src/database.js';
import { createOutboxDispatcherDatabase } from '../src/dispatcher.js';
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

const workspaceA = randomUUID();
const workspaceB = randomUUID();
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

const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: migrationUrl,
  dispatcherRole: 'pertexo_dispatcher',
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
        app.inbox_receipts,
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
  ]);
});

describe('transactional outbox persistence', () => {
  it('inserts with transaction scope and hides the row from another workspace', async () => {
    const input = outboxInput();
    await apiDatabase.withWorkspace(workspaceA, async (transaction) => {
      await insertOutboxEvent(transaction, input);
    });

    const visible = await apiDatabase.withWorkspace(
      workspaceA,
      async ({ db }) =>
        db.select().from(outboxEvents).where(eq(outboxEvents.id, input.id)),
    );
    const hidden = await apiDatabase.withWorkspace(workspaceB, async ({ db }) =>
      db.select().from(outboxEvents).where(eq(outboxEvents.id, input.id)),
    );
    expect(visible).toHaveLength(1);
    expect(hidden).toEqual([]);
  });

  it('enforces the 4 KiB payload cap in PostgreSQL when the helper is bypassed', async () => {
    await expect(
      apiDatabase.withWorkspace(workspaceA, async ({ db, workspaceId }) => {
        await db.insert(outboxEvents).values({
          id: randomUUID(),
          workspaceId,
          jobName: 'phase0-duplicate-proof',
          schemaVersion: 1,
          aggregateType: 'queue-proof',
          aggregateId: randomUUID(),
          payload: { value: 'x'.repeat(4_096) },
          payloadChecksum: checksumA,
        });
      }),
    ).rejects.toSatisfy(hasPostgresCode('23514'));
  });

  it('commits and rolls back domain acceptance with its outbox event', async () => {
    const acceptanceId = randomUUID();
    const eventInput = outboxInput();
    const accept = async (shouldFail: boolean): Promise<void> =>
      apiDatabase.withWorkspace(workspaceA, async (transaction) => {
        await insertOutboxEvent(transaction, eventInput);
        await transaction.db.execute(sql`
          insert into app.queue_duplicate_probe_acceptances
            (id, workspace_id, acceptance_key, request_hash, outbox_event_id)
          values (
            ${acceptanceId},
            ${transaction.workspaceId},
            ${`accept:${acceptanceId}`},
            ${checksumA},
            ${eventInput.id}
          )
        `);
        if (shouldFail) throw new Error('injected acceptance failure');
      });

    await expect(accept(true)).rejects.toThrow('injected acceptance failure');
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      const acceptanceCount = await db.execute(sql`
        select count(*)::integer as count
        from app.queue_duplicate_probe_acceptances
      `);
      const outboxCount = await db
        .select({ count: count() })
        .from(outboxEvents);
      expect(acceptanceCount.rows[0]).toEqual({ count: 0 });
      expect(outboxCount).toEqual([{ count: 0 }]);
    });

    await expect(accept(false)).resolves.toBeUndefined();
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      const acceptanceCount = await db.execute(sql`
        select count(*)::integer as count
        from app.queue_duplicate_probe_acceptances
      `);
      const outboxCount = await db
        .select({ count: count() })
        .from(outboxEvents);
      expect(acceptanceCount.rows[0]).toEqual({ count: 1 });
      expect(outboxCount).toEqual([{ count: 1 }]);
    });
  });

  it('returns an existing acceptance for the same request hash and rejects key reuse', async () => {
    const acceptanceKey = `accept:${randomUUID()}`;
    const accept = async (requestHash: string): Promise<string> =>
      apiDatabase.withWorkspace(workspaceA, async (transaction) => {
        const acceptanceId = randomUUID();
        const claimed = await transaction.db.execute(sql`
          insert into app.queue_duplicate_probe_acceptances
            (id, workspace_id, acceptance_key, request_hash)
          values (
            ${acceptanceId},
            ${transaction.workspaceId},
            ${acceptanceKey},
            ${requestHash}
          )
          on conflict (workspace_id, acceptance_key) do nothing
          returning id
        `);
        if (claimed.rows.length === 0) {
          const existing = await transaction.db.execute(sql`
            select request_hash, outbox_event_id
            from app.queue_duplicate_probe_acceptances
            where workspace_id = ${transaction.workspaceId}
              and acceptance_key = ${acceptanceKey}
          `);
          const row = existing.rows[0];
          if (row?.request_hash !== requestHash) {
            throw new Error('idempotency.request_hash_mismatch');
          }
          if (typeof row.outbox_event_id !== 'string') {
            throw new Error('idempotency.acceptance_incomplete');
          }
          return row.outbox_event_id;
        }

        const eventInput = outboxInput();
        await insertOutboxEvent(transaction, eventInput);
        await transaction.db.execute(sql`
          update app.queue_duplicate_probe_acceptances
          set outbox_event_id = ${eventInput.id}
          where id = ${acceptanceId}
        `);
        return eventInput.id;
      });

    const first = await accept(checksumA);
    await expect(accept(checksumA)).resolves.toBe(first);
    await expect(accept(checksumB)).rejects.toThrow(
      'idempotency.request_hash_mismatch',
    );
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      const rows = await db.execute(sql`
        select count(*)::integer as count
        from app.queue_duplicate_probe_acceptances
        where acceptance_key = ${acceptanceKey}
      `);
      expect(rows.rows[0]).toEqual({ count: 1 });
      expect(await db.select({ count: count() }).from(outboxEvents)).toEqual([
        { count: 1 },
      ]);
    });
  });

  it('claims bounded disjoint batches and changes state only with the lease token', async () => {
    const ids: string[] = Array.from({ length: 4 }, () => randomUUID());
    await apiDatabase.withWorkspace(workspaceA, async (transaction) => {
      for (const id of ids) {
        await insertOutboxEvent(transaction, {
          ...outboxInput(id),
          availableAt: new Date(0),
        });
      }
    });
    const batches = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        dispatcher.claimBatch({
          enabledJobNames,
          leaseDurationMillis: 30_000,
          leaseOwner: `dispatcher-${String(index)}`,
          leaseToken: randomUUID(),
          limit: 2,
          maxAttempts: 3,
        }),
      ),
    );
    const claimed = batches
      .flatMap(({ events }) => events)
      .filter((event) => ids.includes(event.id));
    expect(new Set(claimed.map((event) => event.id)).size).toBe(4);
    const event = claimed[0];
    if (event === undefined) throw new Error('Expected a claimed outbox event');
    await expect(
      dispatcher.markPublished(event.id, randomUUID()),
    ).resolves.toBe(false);
    await expect(
      dispatcher.markPublished(event.id, event.leaseToken),
    ).resolves.toBe(true);
  });

  it('persists fair workspace rotation across dispatcher process replacement', async () => {
    for (const workspaceId of [workspaceA, workspaceB]) {
      await apiDatabase.withWorkspace(workspaceId, async (transaction) => {
        for (let index = 0; index < 2; index += 1)
          await insertOutboxEvent(transaction, {
            ...outboxInput(),
            availableAt: new Date(0),
          });
      });
    }
    const claim = (
      database: ReturnType<typeof createOutboxDispatcherDatabase>,
    ) =>
      database.claimBatch({
        enabledJobNames,
        leaseDurationMillis: 30_000,
        leaseOwner: 'restart-fairness',
        leaseToken: randomUUID(),
        limit: 1,
        maxAttempts: 3,
      });
    const firstProcess = createOutboxDispatcherDatabase(
      parseDatabaseConfig({ connectionString: dispatcherUrl, max: 1 }),
    );
    const first = await claim(firstProcess);
    await firstProcess.close();
    const secondProcess = createOutboxDispatcherDatabase(
      parseDatabaseConfig({ connectionString: dispatcherUrl, max: 1 }),
    );
    try {
      const second = await claim(secondProcess);
      expect(first.events).toHaveLength(1);
      expect(second.events).toHaveLength(1);
      expect(second.events[0]?.workspaceId).not.toBe(
        first.events[0]?.workspaceId,
      );
    } finally {
      await secondProcess.close();
    }
  });

  it('observes only due and currently claimable outbox backlog', async () => {
    const dueId = randomUUID();
    await apiDatabase.withWorkspace(workspaceA, async (transaction) => {
      await insertOutboxEvent(transaction, {
        ...outboxInput(dueId),
        availableAt: new Date(Date.now() - 2_000),
      });
      await insertOutboxEvent(transaction, {
        ...outboxInput(),
        availableAt: new Date(Date.now() + 60_000),
      });
    });

    const due = await dispatcher.observeBacklog({ enabledJobNames });
    expect(due.backlog).toBe(1);
    expect(due.oldestAgeSeconds).toBeGreaterThanOrEqual(1);

    await dispatcher.claimBatch({
      enabledJobNames,
      leaseDurationMillis: 30_000,
      leaseOwner: 'observer-proof',
      leaseToken: randomUUID(),
      limit: 1,
      maxAttempts: 3,
    });
    await expect(
      dispatcher.observeBacklog({ enabledJobNames }),
    ).resolves.toEqual({ backlog: 0 });
  });

  it('keeps disabled job kinds durable and unattempted while enabled work is claimable', async () => {
    const enabledId = randomUUID();
    const heldId = randomUUID();
    await apiDatabase.withWorkspace(workspaceA, async (transaction) => {
      await insertOutboxEvent(transaction, {
        ...outboxInput(enabledId),
        availableAt: new Date(0),
      });
      await insertOutboxEvent(transaction, {
        ...outboxInput(heldId),
        availableAt: new Date(0),
        jobName: 'reconcile-workflow-triggers',
      });
    });

    await expect(
      dispatcher.observeBacklog({ enabledJobNames }),
    ).resolves.toMatchObject({ backlog: 1 });
    const claimed = await dispatcher.claimBatch({
      enabledJobNames,
      leaseDurationMillis: 30_000,
      leaseOwner: 'allowlist-proof',
      leaseToken: randomUUID(),
      limit: 100,
      maxAttempts: 3,
    });
    expect(claimed.events.map((event) => event.id)).toContain(enabledId);
    expect(claimed.events.map((event) => event.id)).not.toContain(heldId);

    const held = await apiDatabase.withWorkspace(workspaceA, async ({ db }) =>
      db
        .select({
          failedAt: outboxEvents.failedAt,
          leaseExpiresAt: outboxEvents.leaseExpiresAt,
          leaseOwner: outboxEvents.leaseOwner,
          leaseToken: outboxEvents.leaseToken,
          publishAttempts: outboxEvents.publishAttempts,
          publishedAt: outboxEvents.publishedAt,
        })
        .from(outboxEvents)
        .where(eq(outboxEvents.id, heldId)),
    );
    expect(held).toEqual([
      {
        failedAt: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        leaseToken: null,
        publishAttempts: 0,
        publishedAt: null,
      },
    ]);

    await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute(sql`
        with held_rows as (
          select gen_random_uuid() as id, gen_random_uuid() as aggregate_id
          from generate_series(1, 2000)
        )
        insert into app.outbox_events
          (id, workspace_id, job_name, schema_version, aggregate_type,
           aggregate_id, payload, payload_checksum, available_at)
        select id, ${workspaceA}, 'reconcile-workflow-triggers', 1,
          'workflow', aggregate_id,
          jsonb_build_object(
            'schemaVersion', 1,
            'workspaceId', ${workspaceA}::uuid,
            'outboxEventId', id,
            'workflowId', aggregate_id,
            'publishedVersionId', aggregate_id
          ), repeat('0', 64), to_timestamp(0)
        from held_rows
      `),
    );
    const ownerPool = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      const owner = await ownerPool.connect();
      try {
        await owner.query('begin');
        await owner.query('set local role pertexo_owner');
        await owner.query('analyze app.outbox_events');
        await owner.query('commit');
      } catch (error: unknown) {
        await owner.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        owner.release();
      }
    } finally {
      await ownerPool.end();
    }

    const explainPool = new Pool({ connectionString: dispatcherUrl, max: 1 });
    try {
      await explainPool.query('set enable_seqscan = off');
      const plan = await explainPool.query<Record<string, unknown>>(
        `explain (format json, costs false)
         select id from app.outbox_events
         where published_at is null and failed_at is null
           and job_name = any($1::varchar[])
           and available_at <= clock_timestamp()
           and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
         order by available_at, id limit 100`,
        [enabledJobNames],
      );
      expect(JSON.stringify(plan.rows)).toContain(
        'outbox_events_dispatch_job_due_idx',
      );
    } finally {
      await explainPool.end();
    }
  });

  it('reclaims expired leases and reaches an explicit attempt failure threshold', async () => {
    const id = randomUUID();
    await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      insertOutboxEvent(transaction, {
        ...outboxInput(id),
        availableAt: new Date(0),
      }).then(() => undefined),
    );
    const first = await dispatcher.claimBatch({
      enabledJobNames,
      leaseDurationMillis: 30_000,
      leaseOwner: 'dispatcher-a',
      leaseToken: randomUUID(),
      limit: 100,
      maxAttempts: 2,
    });
    const leased = first.events.find((event) => event.id === id);
    expect(leased?.publishAttempts).toBe(1);
    await expireLease(id);
    const second = await dispatcher.claimBatch({
      enabledJobNames,
      leaseDurationMillis: 30_000,
      leaseOwner: 'dispatcher-b',
      leaseToken: randomUUID(),
      limit: 100,
      maxAttempts: 2,
    });
    const reclaimed = second.events.find((event) => event.id === id);
    expect(reclaimed?.publishAttempts).toBe(2);
    if (reclaimed === undefined)
      throw new Error('Expected expired lease reclaim');
    await expect(
      dispatcher.releaseOrFail({
        id,
        leaseToken: reclaimed.leaseToken,
        errorCode: 'redis.unavailable',
        maxAttempts: 2,
        retryAt: new Date(),
      }),
    ).resolves.toBe('failed');
  });

  it('atomically fails an event when crash-only lease cycles exhaust the claim limit', async () => {
    const id = randomUUID();
    await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      insertOutboxEvent(transaction, {
        ...outboxInput(id),
        availableAt: new Date(0),
      }).then(() => undefined),
    );

    for (const [expectedAttempt, leaseOwner] of [
      [1, 'crash-1'],
      [2, 'crash-2'],
    ] as const) {
      const claimed = await dispatcher.claimBatch({
        enabledJobNames,
        leaseDurationMillis: 30_000,
        leaseOwner,
        leaseToken: randomUUID(),
        limit: 100,
        maxAttempts: 2,
      });
      expect(
        claimed.events.find((event) => event.id === id)?.publishAttempts,
      ).toBe(expectedAttempt);
      await expireLease(id);
    }

    const afterExhaustion = await dispatcher.claimBatch({
      enabledJobNames,
      leaseDurationMillis: 30_000,
      leaseOwner: 'must-not-claim',
      leaseToken: randomUUID(),
      limit: 100,
      maxAttempts: 2,
    });
    expect(afterExhaustion.events.some((event) => event.id === id)).toBe(false);
    expect(afterExhaustion.exhaustedCount).toBe(1);

    const row = await apiDatabase.withWorkspace(workspaceA, async ({ db }) =>
      db
        .select({
          failedAt: outboxEvents.failedAt,
          lastErrorCode: outboxEvents.lastErrorCode,
          leaseToken: outboxEvents.leaseToken,
          publishAttempts: outboxEvents.publishAttempts,
        })
        .from(outboxEvents)
        .where(eq(outboxEvents.id, id)),
    );
    expect(row).toHaveLength(1);
    expect(row[0]?.failedAt).toBeInstanceOf(Date);
    expect(row[0]).toMatchObject({
      lastErrorCode: 'publish.attempts_exhausted',
      leaseToken: null,
      publishAttempts: 2,
    });
  });

  it('allows dispatcher lifecycle mutations but rejects immutable event rewrites', async () => {
    const input = outboxInput();
    await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      insertOutboxEvent(transaction, {
        ...input,
        availableAt: new Date(0),
      }).then(() => undefined),
    );
    const claimed = await dispatcher.claimBatch({
      enabledJobNames,
      leaseDurationMillis: 30_000,
      leaseOwner: 'least-privilege-proof',
      leaseToken: randomUUID(),
      limit: 100,
      maxAttempts: 3,
    });
    const event = claimed.events.find(({ id }) => id === input.id);
    if (event === undefined) throw new Error('Expected a claimed outbox event');

    const dispatcherPool = new Pool({
      connectionString: dispatcherUrl,
      max: 1,
    });
    try {
      for (const statement of [
        'update app.outbox_events set workspace_id = $2 where id = $1',
        "update app.outbox_events set job_name = 'rewritten' where id = $1",
        'update app.outbox_events set payload = $2::jsonb where id = $1',
        'update app.outbox_events set created_at = clock_timestamp() where id = $1',
      ]) {
        const values = statement.includes('$2')
          ? statement.includes('workspace_id')
            ? [input.id, workspaceB]
            : [input.id, JSON.stringify({ rewritten: true })]
          : [input.id];
        await expect(dispatcherPool.query(statement, values)).rejects.toSatisfy(
          hasPostgresCode('42501'),
        );
      }
    } finally {
      await dispatcherPool.end();
    }

    await expect(
      dispatcher.releaseOrFail({
        id: event.id,
        leaseToken: event.leaseToken,
        errorCode: 'redis.unavailable',
        maxAttempts: 3,
        retryAt: new Date(0),
      }),
    ).resolves.toBe('retry_scheduled');
  });

  it('verifies the dedicated dispatcher grants and migration head', async () => {
    await expect(dispatcher.checkReadiness()).resolves.toBeUndefined();
  });
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
