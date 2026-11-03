import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  transport,
  apiDatabase,
  apiUrl,
  checksumA,
  hasPostgresCode,
  workspaceA,
  workspaceB,
  outboxInput,
  checksumB,
  dispatcher,
  dispatcherUrl,
  enabledJobNames,
  migrationUrl,
  expireLease,
  operator,
  operatorReplica,
} from './persistence/fixture.js';
import { randomUUID } from 'node:crypto';
import { count, eq, sql } from 'drizzle-orm';
import { insertOutboxEvent } from '@pertexo/database/primitives';
import {
  outboxEvents,
  auditEvents,
  inboxReceipts,
} from '@pertexo/database/schema';
import {
  readQ11DatabaseIdentity,
  recordQ11Operation,
  waitForQ11OverlapBarrier,
} from '../support/q11-benchmark.js';
import {
  parseDatabaseConfig,
  createWorkspaceDatabase,
} from '@pertexo/database/platform';
import { consumeInboxMessage } from '../../src/testing.js';
import { createPostgresCommitAckProxy } from '@pertexo/database/testing';
import { createOutboxDispatcherDatabase } from '../../src/outbox/dispatcher/outbox-dispatcher.store.js';
import { Pool } from 'pg';
import { OperatorCommandConflictError } from '../../src/operator/operator-command.js';
import { DELIVERY_CONSUMER } from '../../src/outbox/delivery-consumers.js';
import { settleOverdueDeliveries } from '../../src/outbox/overdue-deliveries.repository.js';

// A first job only leaves with a capacity reservation for a real run.
const KINDS_THAT_NEED_NO_RUN = Object.keys(DELIVERY_CONSUMER).filter(
  (jobName) => jobName !== 'advance-workflow-run',
);

const redeliver = async (
  id: string,
  jobNames: readonly string[] = enabledJobNames,
) => {
  const claimed = await dispatcher.claimBatch({
    enabledJobNames: jobNames,
    leaseDurationMillis: 30_000,
    leaseOwner: 'overdue-proof',
    leaseToken: randomUUID(),
    limit: 100,
  });
  const event = claimed.events.find((candidate) => candidate.id === id);
  if (event === undefined) throw new Error('Expected the event to be claimed');
  await dispatcher.markPublished(event.id, event.leaseToken);
  return event;
};

const publish = async (
  jobName: string = enabledJobNames[0] ?? '',
): Promise<string> => {
  const input = { ...outboxInput(), jobName };
  await apiDatabase.withWorkspace(workspaceA, (transaction) =>
    insertOutboxEvent(transaction, {
      ...input,
      availableAt: new Date(0),
    }).then(() => undefined),
  );
  await redeliver(input.id, [jobName]);
  return input.id;
};

const read = async (id: string) => {
  const [row] = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
    db.select().from(outboxEvents).where(eq(outboxEvents.id, id)),
  );
  if (row === undefined) throw new Error('Expected the event');
  return row;
};

beforeAll(transport.initialize);
beforeEach(transport.reset);
afterAll(transport.close);
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
    const accept = async (
      shouldFail: boolean,
      acceptedId = acceptanceId,
      acceptedEvent = eventInput,
    ): Promise<void> =>
      apiDatabase.withWorkspace(workspaceA, async (transaction) => {
        await insertOutboxEvent(transaction, acceptedEvent);
        await transaction.db.execute(sql`
          insert into app.queue_duplicate_probe_acceptances
            (id, workspace_id, acceptance_key, request_hash, outbox_event_id)
          values (
            ${acceptedId},
            ${transaction.workspaceId},
            ${`accept:${acceptedId}`},
            ${checksumA},
            ${acceptedEvent.id}
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

    await waitForQ11OverlapBarrier();
    const databaseIdentity = await readQ11DatabaseIdentity(apiUrl);
    const operationPopulation =
      process.env.PERTEXO_Q11_OPERATION_TIMING === '1' ? 32 : 1;
    const operationStartedAt = performance.now();
    await expect(
      Promise.all(
        Array.from({ length: operationPopulation }, (_, index) =>
          index === 0
            ? accept(false)
            : accept(false, randomUUID(), outboxInput()),
        ),
      ),
    ).resolves.toHaveLength(operationPopulation);
    recordQ11Operation('foreground-acceptance', operationStartedAt, {
      population: operationPopulation,
      boundary:
        'concurrent real-role acceptance transactions through durable commit',
      databaseIdentity: databaseIdentity,
    });
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      const acceptanceCount = await db.execute(sql`
        select count(*)::integer as count
        from app.queue_duplicate_probe_acceptances
      `);
      const outboxCount = await db
        .select({ count: count() })
        .from(outboxEvents);
      expect(acceptanceCount.rows[0]).toEqual({ count: operationPopulation });
      expect(outboxCount).toEqual([{ count: operationPopulation }]);
    });
  });

  it('recovers an atomic inbox outcome after the COMMIT acknowledgement is lost', async () => {
    const proxy = await createPostgresCommitAckProxy(apiUrl);
    const proxiedDatabase = createWorkspaceDatabase(
      parseDatabaseConfig({ connectionString: proxy.url, max: 1 }),
    );
    const consumerName = 'commit-ack-proof';
    const normalMessageId = randomUUID();
    const rollbackMessageId = randomUUID();
    const lostAckMessageId = randomUUID();
    const normalAcceptanceId = randomUUID();
    const rollbackAcceptanceId = randomUUID();
    const lostAckAcceptanceId = randomUUID();
    const normalOutbox = outboxInput();
    const rollbackOutbox = outboxInput();
    const lostAckOutbox = outboxInput();
    let lostAckWorkCalls = 0;

    const consume = (
      messageId: string,
      acceptanceId: string,
      event: ReturnType<typeof outboxInput>,
      failBeforeCommit = false,
    ) =>
      consumeInboxMessage(proxiedDatabase, workspaceA, {
        message: { consumerName, messageId, payloadChecksum: checksumA },
        operation: async (transaction) => {
          if (messageId === lostAckMessageId) lostAckWorkCalls += 1;
          await insertOutboxEvent(transaction, event);
          await transaction.db.execute(sql`
            insert into app.queue_duplicate_probe_acceptances
              (id, workspace_id, acceptance_key, request_hash, outbox_event_id)
            values (
              ${acceptanceId},
              ${transaction.workspaceId},
              ${`commit-ack:${acceptanceId}`},
              ${checksumA},
              ${event.id}
            )
          `);
          if (failBeforeCommit) throw new Error('pre-commit control failure');
          return event.id;
        },
      });

    const inspect = async (
      acceptanceId: string,
      messageId: string,
      outboxId: string,
    ) =>
      apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
        const durable = await db.execute(sql`
          select
            (select count(*)::integer
               from app.queue_duplicate_probe_acceptances
              where id = ${acceptanceId}) acceptance_count,
            (select count(*)::integer
               from app.inbox_receipts
              where consumer_name = ${consumerName}
                and message_id = ${messageId}
                and completed_at is not null) completed_receipt_count,
            (select count(*)::integer
               from app.outbox_events
              where id = ${outboxId}) outbox_count
        `);
        return durable.rows[0];
      });

    try {
      await expect(
        consume(normalMessageId, normalAcceptanceId, normalOutbox),
      ).resolves.toEqual({ status: 'processed', value: normalOutbox.id });
      await expect(
        inspect(normalAcceptanceId, normalMessageId, normalOutbox.id),
      ).resolves.toEqual({
        acceptance_count: 1,
        completed_receipt_count: 1,
        outbox_count: 1,
      });

      await expect(
        consume(rollbackMessageId, rollbackAcceptanceId, rollbackOutbox, true),
      ).rejects.toThrow('pre-commit control failure');
      await expect(
        inspect(rollbackAcceptanceId, rollbackMessageId, rollbackOutbox.id),
      ).resolves.toEqual({
        acceptance_count: 0,
        completed_receipt_count: 0,
        outbox_count: 0,
      });
      await expect(
        consume(rollbackMessageId, rollbackAcceptanceId, rollbackOutbox),
      ).resolves.toEqual({ status: 'processed', value: rollbackOutbox.id });
      await expect(
        inspect(rollbackAcceptanceId, rollbackMessageId, rollbackOutbox.id),
      ).resolves.toEqual({
        acceptance_count: 1,
        completed_receipt_count: 1,
        outbox_count: 1,
      });

      const acknowledgementDropped = proxy.dropNextCommitAcknowledgement();
      const uncertain = consume(
        lostAckMessageId,
        lostAckAcceptanceId,
        lostAckOutbox,
      );
      const observedUncertain = uncertain.then(
        () => undefined,
        (error: unknown) => error,
      );
      await acknowledgementDropped;
      expect(await observedUncertain).toBeInstanceOf(Error);
      await expect(
        inspect(lostAckAcceptanceId, lostAckMessageId, lostAckOutbox.id),
      ).resolves.toEqual({
        acceptance_count: 1,
        completed_receipt_count: 1,
        outbox_count: 1,
      });

      await expect(
        consume(lostAckMessageId, lostAckAcceptanceId, lostAckOutbox),
      ).resolves.toEqual({ status: 'duplicate' });
      expect(lostAckWorkCalls).toBe(1);
      expect(proxy.droppedConnectionCount()).toBe(1);
      expect(proxy.connectionCount()).toBeGreaterThanOrEqual(2);
      await expect(
        inspect(lostAckAcceptanceId, lostAckMessageId, lostAckOutbox.id),
      ).resolves.toEqual({
        acceptance_count: 1,
        completed_receipt_count: 1,
        outbox_count: 1,
      });
      await proxiedDatabase.close();
      await proxy.close();
      expect(proxy.activeSocketCount()).toBe(0);
    } finally {
      await Promise.all([proxiedDatabase.close(), proxy.close()]);
    }
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
        }),
      ),
    );
    const claimed = batches
      .flatMap(({ events }) => events)
      .filter((event) => ids.includes(event.id));
    expect(new Set(claimed.map((event) => event.id)).size).toBe(4);
    const event = claimed[0];
    if (event === undefined) throw new Error('Expected a claimed outbox event');
    expect(event.availableAt).toBeInstanceOf(Date);
    expect(event.leaseExpiresAt).toBeInstanceOf(Date);
    expect(Object.isFrozen(event)).toBe(true);
    await expect(
      dispatcher.markPublished(event.id, randomUUID()),
    ).resolves.toBe(false);
    await expect(
      dispatcher.markPublished(event.id, event.leaseToken),
    ).resolves.toBe(true);
  });

  it('shares a batch equally between workspaces and gives a lone one all of it', async () => {
    const claim = (limit: number) =>
      dispatcher.claimBatch({
        enabledJobNames,
        leaseDurationMillis: 30_000,
        leaseOwner: 'share-proof',
        leaseToken: randomUUID(),
        limit,
      });
    const insert = async (workspaceId: string, count: number) => {
      await apiDatabase.withWorkspace(workspaceId, async (transaction) => {
        for (let index = 0; index < count; index += 1)
          await insertOutboxEvent(transaction, {
            ...outboxInput(randomUUID()),
            availableAt: new Date(0),
          });
      });
    };
    // Anything earlier cases left claimable would take a share.
    while ((await claim(100)).events.length > 0);

    await insert(workspaceA, 3);
    const alone = await claim(3);
    expect(alone.events.map(({ workspaceId }) => workspaceId)).toEqual([
      workspaceA,
      workspaceA,
      workspaceA,
    ]);

    await insert(workspaceA, 3);
    await insert(workspaceB, 3);
    const { events } = await claim(4);
    expect(
      events.filter(({ workspaceId }) => workspaceId === workspaceA),
    ).toHaveLength(2);
    expect(
      events.filter(({ workspaceId }) => workspaceId === workspaceB),
    ).toHaveLength(2);
  });

  it('never claims past the batch, and a busy workspace cannot crowd out a quiet one', async () => {
    const claim = (limit: number) =>
      dispatcher.claimBatch({
        enabledJobNames,
        leaseDurationMillis: 30_000,
        leaseOwner: 'share-bound-proof',
        leaseToken: randomUUID(),
        limit,
      });
    const insert = async (workspaceId: string, count: number) => {
      await apiDatabase.withWorkspace(workspaceId, async (transaction) => {
        for (let index = 0; index < count; index += 1)
          await insertOutboxEvent(transaction, {
            ...outboxInput(randomUUID()),
            availableAt: new Date(0),
          });
      });
    };
    while ((await claim(100)).events.length > 0);

    // Twenty waiting in one, one in the other, and a batch that doesn't divide evenly.
    await insert(workspaceA, 20);
    await insert(workspaceB, 1);
    const { events } = await claim(5);

    expect(events.length).toBeLessThanOrEqual(5);
    expect(
      events.filter(({ workspaceId }) => workspaceId === workspaceB),
    ).toHaveLength(1);
    expect(
      events.filter(({ workspaceId }) => workspaceId === workspaceA).length,
    ).toBeGreaterThan(1);
    while ((await claim(100)).events.length > 0);

    // Both busy, so an uneven share has nowhere to fall but past the limit.
    await insert(workspaceA, 5);
    await insert(workspaceB, 5);
    expect((await claim(5)).events.length).toBeLessThanOrEqual(5);
    while ((await claim(100)).events.length > 0);
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
    });
    await expect(
      dispatcher.observeBacklog({ enabledJobNames }),
    ).resolves.toEqual({ backlog: 0 });
  });

  it('schedules a retry only for the current lease and hides it until due', async () => {
    const id = randomUUID();
    await apiDatabase.withWorkspace(workspaceA, async (transaction) => {
      await insertOutboxEvent(transaction, {
        ...outboxInput(id),
        availableAt: new Date(0),
      });
    });
    const claimed = await dispatcher.claimBatch({
      enabledJobNames,
      leaseDurationMillis: 30_000,
      leaseOwner: 'retry-proof',
      leaseToken: randomUUID(),
      limit: 1,
    });
    const event = claimed.events.find((candidate) => candidate.id === id);
    if (event === undefined) throw new Error('Expected retry fixture claim');
    const retry = {
      id,
      leaseToken: event.leaseToken,
      disposition: 'retry' as const,
      retryDelayMillis: 60_000,
      errorCode: 'queue.unavailable',
    };
    await expect(
      dispatcher.releaseOrFail({ ...retry, leaseToken: randomUUID() }),
    ).resolves.toBe('not_leased');
    await expect(dispatcher.releaseOrFail(retry)).resolves.toBe(
      'retry_scheduled',
    );
    await expect(dispatcher.releaseOrFail(retry)).resolves.toBe('not_leased');
    await expect(dispatcher.markPublished(id, event.leaseToken)).resolves.toBe(
      false,
    );
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
          (id, workspace_id, job_name, aggregate_type,
           aggregate_id, payload, payload_checksum, available_at)
        select id, ${workspaceA}, 'reconcile-workflow-triggers',
          'workflow', aggregate_id,
          jsonb_build_object(
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
    });
    const reclaimed = second.events.find((event) => event.id === id);
    expect(reclaimed?.publishAttempts).toBe(2);
    if (reclaimed === undefined)
      throw new Error('Expected expired lease reclaim');
    await expect(
      dispatcher.releaseOrFail({
        id,
        leaseToken: reclaimed.leaseToken,
        errorCode: 'outbox.checksum_mismatch',
        disposition: 'fail',
      }),
    ).resolves.toBe('failed');
  });

  // backend-gaps-01: crash-only lease cycles used to end an event at a claim
  // limit, stranding its run; only a row that can never publish ends now.
  it('keeps claiming an event through any number of crash-only lease cycles', async () => {
    const id = randomUUID();
    await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      insertOutboxEvent(transaction, {
        ...outboxInput(id),
        availableAt: new Date(0),
      }).then(() => undefined),
    );

    for (const expectedAttempt of [1, 2, 3, 4]) {
      const claimed = await dispatcher.claimBatch({
        enabledJobNames,
        leaseDurationMillis: 30_000,
        leaseOwner: `crash-${String(expectedAttempt)}`,
        leaseToken: randomUUID(),
        limit: 100,
      });
      expect(
        claimed.events.find((event) => event.id === id)?.publishAttempts,
      ).toBe(expectedAttempt);
      await expireLease(id);
    }

    const row = await apiDatabase.withWorkspace(workspaceA, async ({ db }) =>
      db
        .select({ failedAt: outboxEvents.failedAt })
        .from(outboxEvents)
        .where(eq(outboxEvents.id, id)),
    );
    expect(row).toEqual([{ failedAt: null }]);
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
        let queryValues;
        if (statement.includes('$2')) {
          if (statement.includes('workspace_id')) {
            queryValues = [input.id, workspaceB];
          } else {
            queryValues = [input.id, JSON.stringify({ rewritten: true })];
          }
        } else {
          queryValues = [input.id];
        }
        const values = queryValues;
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
        disposition: 'retry',
        retryDelayMillis: 0,
      }),
    ).resolves.toBe('retry_scheduled');
  });

  it('verifies the dedicated dispatcher grants and migration head', async () => {
    await expect(dispatcher.checkReadiness()).resolves.toBeUndefined();
  });

  it('dry-runs and exactly replays a durable failed-row redispatch command', async () => {
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
      leaseOwner: 'operator-proof',
      leaseToken: randomUUID(),
      limit: 1,
    });
    const event = claimed.events.find(({ id }) => id === input.id);
    if (event === undefined)
      throw new Error('Expected failed-row fixture claim');
    await expect(
      dispatcher.releaseOrFail({
        errorCode: 'redis.unavailable',
        id: event.id,
        leaseToken: event.leaseToken,
        disposition: 'fail',
      }),
    ).resolves.toBe('failed');

    const commandId = randomUUID();
    const command = {
      actorRef: 'ci-test-operator',
      commandId,
      dryRun: true,
      outboxEventId: input.id,
      reason: 'prove bounded failed outbox redispatch',
      workspaceId: workspaceA,
    } as const;
    const concurrent = await Promise.all([
      operator.redispatchFailedOutbox(command),
      operatorReplica.redispatchFailedOutbox(command),
    ]);
    expect(concurrent.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(concurrent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commandId,
          outcome: 'would_redispatch',
          status: 'completed',
        }),
      ]),
    );
    await expect(
      operator.redispatchFailedOutbox({
        ...command,
        reason: 'conflicting reason',
      }),
    ).rejects.toBeInstanceOf(OperatorCommandConflictError);

    const failed = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.select().from(outboxEvents).where(eq(outboxEvents.id, input.id)),
    );
    expect(failed[0]?.failedAt).toBeInstanceOf(Date);
    expect(failed[0]).toMatchObject({
      lastErrorCode: 'redis.unavailable',
      publishAttempts: 1,
    });
    await expect(
      operator.getCommand({
        actorRef: command.actorRef,
        commandId,
        reason: 'inspect dry-run result',
        workspaceId: workspaceA,
      }),
    ).resolves.toMatchObject({
      commandId,
      outcome: 'would_redispatch',
      priorErrorCode: 'redis.unavailable',
      priorPublishAttempts: 1,
    });
    await expect(
      operator.getCommand({
        actorRef: command.actorRef,
        commandId,
        reason: 'prove workspace-bound lookup',
        workspaceId: workspaceB,
      }),
    ).resolves.toBeNull();
    await expect(
      operator.redispatchFailedOutbox({
        ...command,
        reason: 'cross-workspace conflicting replay',
        workspaceId: workspaceB,
      }),
    ).rejects.toBeInstanceOf(OperatorCommandConflictError);
    await expect(
      operator.getCommand({
        actorRef: command.actorRef,
        commandId,
        reason: 'prove conflict cannot forge workspace binding',
        workspaceId: workspaceB,
      }),
    ).resolves.toBeNull();
    const audits = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(eq(auditEvents.requestId, commandId)),
    );
    expect(audits).toHaveLength(3);
  });

  it('redispatches one failed row without changing immutable transport identity', async () => {
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
      leaseOwner: 'operator-execute-proof',
      leaseToken: randomUUID(),
      limit: 1,
    });
    const event = claimed.events.find(({ id }) => id === input.id);
    if (event === undefined)
      throw new Error('Expected failed-row fixture claim');
    await dispatcher.releaseOrFail({
      errorCode: 'redis.unavailable',
      id: event.id,
      leaseToken: event.leaseToken,
      disposition: 'fail',
    });

    const before = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.select().from(outboxEvents).where(eq(outboxEvents.id, input.id)),
    );
    const commandId = randomUUID();
    await expect(
      operator.redispatchFailedOutbox({
        actorRef: 'ci-test-operator',
        commandId,
        dryRun: false,
        outboxEventId: input.id,
        reason: 'retry after queue recovery',
        workspaceId: workspaceA,
      }),
    ).resolves.toMatchObject({ outcome: 'redispatched', replayed: false });

    const after = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.select().from(outboxEvents).where(eq(outboxEvents.id, input.id)),
    );
    expect(after[0]).toMatchObject({
      aggregateId: before[0]?.aggregateId,
      aggregateType: before[0]?.aggregateType,
      failedAt: null,
      id: before[0]?.id,
      jobName: before[0]?.jobName,
      lastErrorCode: null,
      payload: before[0]?.payload,
      payloadChecksum: before[0]?.payloadChecksum,
      publishAttempts: 0,
      publishedAt: null,
      workspaceId: before[0]?.workspaceId,
    });
    const reclaimed = await dispatcher.claimBatch({
      enabledJobNames,
      leaseDurationMillis: 30_000,
      leaseOwner: 'operator-normal-dispatch',
      leaseToken: randomUUID(),
      limit: 1,
    });
    expect(reclaimed.events.map(({ id }) => id)).toContain(input.id);
  });

  it('keeps the operator role function-only and on the expected migration head', async () => {
    await expect(operator.checkReadiness()).resolves.toBeUndefined();
  });

  // The role the scanner runs as, so this also proves what that role may do.
  let scanner: Pool;

  beforeAll(() => {
    scanner = new Pool({ connectionString: dispatcherUrl, max: 2 });
  });

  afterAll(() => scanner.end());

  const makeDue = (id: string, redeliveries = 0) =>
    scanner.query(
      `update app.outbox_events
          set delivery_due_at=clock_timestamp()-interval '1 second', redeliveries=$2
        where id=$1`,
      [id, redeliveries],
    );

  const settle = () => settleOverdueDeliveries(scanner, 100);

  it('gives every published job kind a time to be confirmed by', async () => {
    const id = await publish();
    const { deliveryDueAt, publishedAt } = await read(id);
    expect(publishedAt).not.toBeNull();
    expect(deliveryDueAt?.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(deliveryDueAt?.getTime()).toBeLessThan(Date.now() + 70_000);
  });

  it.each(KINDS_THAT_NEED_NO_RUN)(
    'gives a published %s a time to be confirmed by',
    async (jobName) => {
      const { deliveryDueAt } = await read(await publish(jobName));
      expect(deliveryDueAt).not.toBeNull();
    },
  );

  it('leaves a job alone until its time has passed', async () => {
    const id = await publish();
    expect((await settle()).settled).toBe(0);
    expect((await read(id)).redeliveries).toBe(0);
  });

  it('sends an unconfirmed job back to the dispatcher as the same row', async () => {
    const id = await publish();
    const before = await read(id);
    await makeDue(id);

    const { asked } = await settle();

    expect(asked).toMatchObject([
      { outboxEventId: id, redeliveries: 1, gaveUp: false },
    ]);
    const after = await read(id);
    expect(after).toMatchObject({
      publishedAt: null,
      deliveryDueAt: null,
      failedAt: null,
      redeliveries: 1,
      payloadChecksum: before.payloadChecksum,
    });
    expect(after.payload).toEqual(before.payload);
  });

  it('allows the redelivery twice as long, and carries its count to the dispatcher', async () => {
    const id = await publish();
    await makeDue(id);
    await settle();

    const claimed = await dispatcher.claimBatch({
      enabledJobNames,
      leaseDurationMillis: 30_000,
      leaseOwner: 'overdue-proof',
      leaseToken: randomUUID(),
      limit: 100,
    });
    const event = claimed.events.find((candidate) => candidate.id === id);
    expect(event?.redeliveries).toBe(1);
    if (event === undefined) throw new Error('Expected the redelivery');
    await dispatcher.markPublished(event.id, event.leaseToken);

    const { deliveryDueAt } = await read(id);
    expect(deliveryDueAt?.getTime()).toBeGreaterThan(Date.now() + 110_000);
    expect(deliveryDueAt?.getTime()).toBeLessThan(Date.now() + 130_000);
  });

  it('asks again at most once an hour, however often it has asked', async () => {
    const id = await publish();
    await makeDue(id, 8);
    await settle();

    await redeliver(id);

    const { deliveryDueAt } = await read(id);
    expect(deliveryDueAt?.getTime()).toBeGreaterThan(Date.now() + 3_590_000);
    expect(deliveryDueAt?.getTime()).toBeLessThan(Date.now() + 3_610_000);
  });

  it('stops watching a job as soon as its consumer has a receipt', async () => {
    const id = await publish();
    const { payloadChecksum } = await read(id);
    await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.insert(inboxReceipts).values({
        consumerName: 'workflow-coordinator',
        messageId: id,
        workspaceId: workspaceA,
        payloadChecksum,
      }),
    );
    await makeDue(id);

    const { asked, settled } = await settle();

    expect({ asked, settled }).toEqual({ asked: [], settled: 1 });
    const after = await read(id);
    expect(after.deliveryDueAt).toBeNull();
    expect(after.publishedAt).not.toBeNull();
    expect(after.redeliveries).toBe(0);
  });

  it('ends a job that never confirms where an operator can see it', async () => {
    const id = await publish();
    await makeDue(id, 30);

    const { asked } = await settle();

    expect(asked).toMatchObject([{ outboxEventId: id, gaveUp: true }]);
    expect(await read(id)).toMatchObject({
      publishedAt: null,
      lastErrorCode: 'delivery.never_confirmed',
      redeliveries: 30,
    });
    expect((await read(id)).failedAt).not.toBeNull();
  });

  it('delivers again one short of the limit', async () => {
    const id = await publish();
    await makeDue(id, 29);

    const { asked } = await settle();

    expect(asked).toMatchObject([
      { outboxEventId: id, redeliveries: 30, gaveUp: false },
    ]);
    expect((await read(id)).failedAt).toBeNull();
  });

  it('lets an operator send a job given up on, under a job ID Redis has not seen', async () => {
    const id = await publish();
    await makeDue(id, 30);
    await settle();

    await expect(
      operator.redispatchFailedOutbox({
        actorRef: 'overdue-proof',
        commandId: randomUUID(),
        dryRun: false,
        outboxEventId: id,
        reason: 'fixed what stopped it being confirmed',
        workspaceId: workspaceA,
      }),
    ).resolves.toMatchObject({ outcome: 'redispatched' });

    const event = await redeliver(id);
    expect(event.redeliveries).toBe(31);
    expect((await read(id)).failedAt).toBeNull();
  });

  it('leaves alone a row that failed to publish', async () => {
    const id = await publish();
    await scanner.query(
      `update app.outbox_events
          set published_at=null, failed_at=clock_timestamp(),
              delivery_due_at=clock_timestamp()-interval '1 second'
        where id=$1`,
      [id],
    );
    const before = await read(id);

    const { asked } = await settle();

    expect(asked).toEqual([]);
    expect(await read(id)).toEqual(before);
  });

  it('gives a row held by someone else to one scanner, once it is free', async () => {
    const id = await publish();
    await makeDue(id);
    const holder = new Pool({ connectionString: dispatcherUrl, max: 1 });
    const client = await holder.connect();
    let scans: Awaited<ReturnType<typeof settle>>[];
    try {
      await client.query('begin');
      await client.query(
        'select 1 from app.outbox_events where id=$1 for update',
        [id],
      );
      // Both have read the row as due by now, if a read is all they do first.
      const both = Promise.all([settle(), settle()]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await client.query('commit');
      scans = await both;
    } finally {
      client.release();
      await holder.end();
    }
    scans.push(await settle());

    const askedOf = scans.flatMap(({ asked }) =>
      asked.filter(({ outboxEventId }) => outboxEventId === id),
    );
    expect(askedOf).toHaveLength(1);
    expect((await read(id)).redeliveries).toBe(1);
  });

  it('never gives one row to two scanners', async () => {
    const id = await publish();
    await makeDue(id);

    const [first, second] = await Promise.all([settle(), settle()]);

    expect(first.asked.length + second.asked.length).toBe(1);
    expect((await read(id)).redeliveries).toBe(1);
  });
});
