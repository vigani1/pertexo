import { randomUUID } from 'node:crypto';

import { count, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createOutboxDispatcherDatabase } from '../src/execution/dispatcher.js';
import { OperatorCommandConflictError } from '../src/operator/operator-commands.js';
import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../src/execution/outbox.js';
import { auditEvents, outboxEvents } from '../src/schema.js';
import { createTransportTestEnvironment } from './support/transport.integration.support.js';

const transport = createTransportTestEnvironment();
const {
  apiDatabase,
  checksumA,
  checksumB,
  dispatcher,
  dispatcherUrl,
  hasPostgresCode,
  migrationUrl,
  operator,
  operatorReplica,
  workspaceA,
  workspaceB,
} = transport;
const enabledJobNames = Object.freeze(['phase0-duplicate-proof']);

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
      maxAttempts: 1,
    });
    const event = claimed.events.find(({ id }) => id === input.id);
    if (event === undefined)
      throw new Error('Expected failed-row fixture claim');
    await expect(
      dispatcher.releaseOrFail({
        errorCode: 'redis.unavailable',
        id: event.id,
        leaseToken: event.leaseToken,
        maxAttempts: 1,
        retryAt: new Date(),
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
      maxAttempts: 1,
    });
    const event = claimed.events.find(({ id }) => id === input.id);
    if (event === undefined)
      throw new Error('Expected failed-row fixture claim');
    await dispatcher.releaseOrFail({
      errorCode: 'redis.unavailable',
      id: event.id,
      leaseToken: event.leaseToken,
      maxAttempts: 1,
      retryAt: new Date(),
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
      schemaVersion: before[0]?.schemaVersion,
      workspaceId: before[0]?.workspaceId,
    });
    const reclaimed = await dispatcher.claimBatch({
      enabledJobNames,
      leaseDurationMillis: 30_000,
      leaseOwner: 'operator-normal-dispatch',
      leaseToken: randomUUID(),
      limit: 1,
      maxAttempts: 3,
    });
    expect(reclaimed.events.map(({ id }) => id)).toContain(input.id);
  });

  it('keeps the operator role function-only and on the expected migration head', async () => {
    await expect(operator.checkReadiness()).resolves.toBeUndefined();
  });
});
