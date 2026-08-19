import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';

import {
  consumeInboxMessage,
  canonicalOutboxPayloadChecksum,
  createOutboxDispatcherDatabase,
  createWorkspaceDatabase,
  InboxChecksumMismatchError,
  InboxReceiptUnavailableError,
  insertOutboxEvent,
  outboxEvents,
  parseDatabaseConfig,
} from '@pertexo/database';
import type { TransportMetrics } from '@pertexo/observability/transport-metrics';
import {
  createQueueConsumer,
  createQueueProducer,
  JOB_NAME,
  QUEUE_NAME,
  unrecoverableQueueError,
} from '@pertexo/queue';
import type { QueueJobHandler } from '@pertexo/queue';
import { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/unbound-method -- assertions target injected metric boundary fakes */

import { WorkerDrainState } from '../src/runtime/worker-drain-state.js';
import { OutboxDispatcher } from '../src/transport/outbox-dispatcher.js';
import { createQueueMetricsObserver } from '../src/transport/transport-metrics-adapter.js';

const integration = process.env.WORKER_TRANSPORT_INTEGRATION === 'true';
const describeIntegration = integration ? describe : describe.skip;

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
const redisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';

const workspaceId = randomUUID();
const apiDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
);
const workerDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: workerUrl, max: 4 }),
);
const proofIds = new Set<string>();

function capturingTransportMetrics(): TransportMetrics {
  return {
    addActiveConcurrency: vi.fn(),
    observeOutbox: vi.fn(),
    observeQueue: vi.fn(),
    recordHandlerFinished: vi.fn(),
    recordOutboxClaim: vi.fn(),
    recordOutboxLeaseEvent: vi.fn(),
    recordOutboxPublish: vi.fn(),
  };
}

function checksum(value: unknown): string {
  return canonicalOutboxPayloadChecksum(value);
}

function redisConnection(): {
  host: string;
  password?: string;
  port: number;
} {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password === ''
      ? {}
      : { password: decodeURIComponent(url.password) }),
  };
}

async function applyLedgerFixture(): Promise<void> {
  const source = await readFile(
    new URL(
      '../../../packages/database/test/fixtures/queue-duplicate-proof.sql',
      import.meta.url,
    ),
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

async function insertRunEvent(id = randomUUID()): Promise<string> {
  proofIds.add(id);
  const payload = { runId: randomUUID() };
  await apiDatabase.withWorkspace(workspaceId, (transaction) =>
    insertOutboxEvent(transaction, {
      aggregateId: payload.runId,
      aggregateType: 'workflow-run',
      availableAt: new Date(0),
      id,
      jobName: JOB_NAME.advanceWorkflowRun,
      payload,
      payloadChecksum: checksum(payload),
      schemaVersion: 1,
    }).then(() => undefined),
  );
  return id;
}

function createDispatcher(owner: string, batchSize = 100): OutboxDispatcher {
  return new OutboxDispatcher(
    createOutboxDispatcherDatabase(
      parseDatabaseConfig({ connectionString: dispatcherUrl, max: 1 }),
    ),
    createQueueProducer({ redisUrl }),
    new WorkerDrainState(),
    {
      batchSize,
      leaseDurationMillis: 1_000,
      leaseOwner: owner,
      maxAttempts: 3,
      operationTimeoutMillis: 5_000,
      retryDelayMillis: 100,
    },
  );
}

async function countLedger(table: string): Promise<number> {
  return workerDatabase.withWorkspace(workspaceId, async ({ db }) => {
    const result = await db.execute(
      sql.raw(
        `select count(*)::integer as count from app.${table} where workspace_id = '${workspaceId}'::uuid`,
      ),
    );
    return (result.rows[0] as { count: number } | undefined)?.count ?? 0;
  });
}

async function consumeProof(
  messageId: string,
  logicalAttemptId: string,
  providerIntent?: Readonly<{
    attemptId: string;
    idempotencyKey: string;
    nodeRunId: string;
    outboxEventId: string;
    runId: string;
  }>,
) {
  return consumeInboxMessage(
    workerDatabase,
    workspaceId,
    {
      consumerName: 'worker.phase0-proof',
      messageId,
      payloadChecksum: checksum({ logicalAttemptId }),
    },
    async (transaction) => {
      const { db, workspaceId: activeWorkspaceId } = transaction;
      await db.execute(sql`
        insert into app.queue_duplicate_probe_attempts
          (id, workspace_id, logical_attempt_id)
        values (${randomUUID()}, ${activeWorkspaceId}, ${logicalAttemptId})
      `);
      await db.execute(sql`
        insert into app.queue_duplicate_probe_events
          (id, workspace_id, logical_attempt_id, sequence)
        values (${randomUUID()}, ${activeWorkspaceId}, ${logicalAttemptId}, 1)
      `);
      await db.execute(sql`
        insert into app.queue_duplicate_probe_usage
          (id, workspace_id, idempotency_key, quantity)
        values (${randomUUID()}, ${activeWorkspaceId}, ${`usage:${logicalAttemptId}`}, 1)
      `);
      if (providerIntent !== undefined) {
        const payload = {
          attemptId: providerIntent.attemptId,
          nodeRunId: providerIntent.nodeRunId,
          runId: providerIntent.runId,
        };
        await insertOutboxEvent(transaction, {
          aggregateId: providerIntent.attemptId,
          aggregateType: 'provider-intent',
          id: providerIntent.outboxEventId,
          jobName: JOB_NAME.executeNodeAttempt,
          payload,
          payloadChecksum: checksum(payload),
          schemaVersion: 1,
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
            ${providerIntent.attemptId},
            ${activeWorkspaceId},
            ${logicalAttemptId},
            ${providerIntent.outboxEventId},
            ${providerIntent.idempotencyKey}
          )
        `);
      }
      return logicalAttemptId;
    },
  );
}

function deferred(): Readonly<{ promise: Promise<void>; resolve(): void }> {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

async function waitForRemovableJob(queue: Queue, id: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = await queue.getJob(id);
    const state = await job?.getState();
    if (state === 'delayed' || state === 'failed') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for removable job ${id}`);
}

async function waitForBalancedConsumerMetrics(
  metrics: TransportMetrics,
  minimumHandlers: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const deltas = vi
      .mocked(metrics.addActiveConcurrency)
      .mock.calls.map(([measurement]) => measurement.delta);
    const started = deltas.filter((delta) => delta === 1).length;
    const finished = deltas.filter((delta) => delta === -1).length;
    if (started >= minimumHandlers && finished === started) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for balanced consumer metrics');
}

async function cleanup(): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    for (const table of [
      'queue_duplicate_probe_provider_effects',
      'queue_duplicate_probe_provider_intents',
      'queue_duplicate_probe_acceptances',
      'queue_duplicate_probe_usage',
      'queue_duplicate_probe_events',
      'queue_duplicate_probe_attempts',
      'inbox_receipts',
      'outbox_events',
    ]) {
      await client.query(`delete from app.${table} where workspace_id = $1`, [
        workspaceId,
      ]);
    }
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

describeIntegration(
  'worker PostgreSQL + Redis transport proof',
  { concurrent: false },
  () => {
    beforeAll(async () => {
      await applyLedgerFixture();
    });

    afterAll(async () => {
      const queue = new Queue(QUEUE_NAME.workflowCoordinator, {
        connection: redisConnection(),
      });
      try {
        for (const id of proofIds) {
          await queue.getJob(`outbox-${id}`).then((job) => job?.remove());
        }
        await cleanup();
      } finally {
        await Promise.all([
          queue.close(),
          apiDatabase.close(),
          workerDatabase.close(),
        ]);
      }
    });

    it('uses SKIP LOCKED across two dispatchers and publishes every outbox ID once', async () => {
      const ids = await Promise.all(
        Array.from({ length: 4 }, () => insertRunEvent()),
      );
      const first = createDispatcher('integration-a', 2);
      const second = createDispatcher('integration-b', 2);
      try {
        await Promise.all([first.checkReadiness(), second.checkReadiness()]);
        const results = await Promise.all([
          first.dispatchOnce(),
          second.dispatchOnce(),
        ]);
        expect(results.map((result) => result.claimed).sort()).toEqual([2, 2]);
        const queue = new Queue(QUEUE_NAME.workflowCoordinator, {
          connection: redisConnection(),
        });
        try {
          const jobs = await Promise.all(
            ids.map((id) => queue.getJob(`outbox-${id}`)),
          );
          expect(jobs.every((job) => job !== undefined)).toBe(true);
        } finally {
          await queue.close();
        }
      } finally {
        await Promise.all([first.close(), second.close()]);
      }
    });

    it('reclaims enqueue-before-mark and Bull redelivery becomes an inbox no-op', async () => {
      const id = await insertRunEvent();
      const logicalAttemptId = randomUUID();
      const providerOutboxId = randomUUID();
      const providerAttemptId = randomUUID();
      const providerNodeRunId = randomUUID();
      const providerRunId = randomUUID();
      const providerKey = `provider:${logicalAttemptId}`;
      const acceptedProviderEffects = new Set<string>();
      let providerRequests = 0;
      const provider = createServer((request, response) => {
        providerRequests += 1;
        const key = String(request.headers['idempotency-key']);
        acceptedProviderEffects.add(key);
        if (providerRequests === 1) {
          request.socket.destroy();
          return;
        }
        response.writeHead(200).end();
      });
      await new Promise<void>((resolve) =>
        provider.listen(0, '127.0.0.1', resolve),
      );
      const providerAddress = provider.address();
      if (providerAddress === null || typeof providerAddress === 'string') {
        throw new Error('Fake provider did not bind');
      }
      const rawDispatcher = createOutboxDispatcherDatabase(
        parseDatabaseConfig({ connectionString: dispatcherUrl, max: 1 }),
      );
      const producer = createQueueProducer({ redisUrl });
      const queue = new Queue(QUEUE_NAME.workflowCoordinator, {
        connection: redisConnection(),
      });
      const dispatcher = createDispatcher('integration-reclaimer');
      const receiptStatuses: string[] = [];
      const firstCoordinatorCommit = deferred();
      const duplicateCoordinatorCommit = deferred();
      const providerCompleted = deferred();
      let coordinatorDeliveries = 0;
      let providerDeliveries = 0;
      const consumerMetrics = capturingTransportMetrics();
      const consumerObserver = createQueueMetricsObserver(consumerMetrics);
      const coordinatorHandler: QueueJobHandler = async (delivery) => {
        if (delivery.transport.jobId !== `outbox-${id}`) return;
        coordinatorDeliveries += 1;
        const result = await consumeProof(id, logicalAttemptId, {
          attemptId: providerAttemptId,
          idempotencyKey: providerKey,
          nodeRunId: providerNodeRunId,
          outboxEventId: providerOutboxId,
          runId: providerRunId,
        });
        receiptStatuses.push(result.status);
        if (result.status === 'processed') {
          firstCoordinatorCommit.resolve();
          throw new Error('injected crash after coordinator commit before ack');
        }
        duplicateCoordinatorCommit.resolve();
      };
      const firstCoordinator = createQueueConsumer({
        handler: coordinatorHandler,
        observer: consumerObserver,
        queueName: QUEUE_NAME.workflowCoordinator,
        redisUrl,
      });
      const secondCoordinator = createQueueConsumer({
        handler: coordinatorHandler,
        observer: consumerObserver,
        queueName: QUEUE_NAME.workflowCoordinator,
        redisUrl,
      });
      const providerConsumer = createQueueConsumer({
        handler: async (delivery) => {
          if (delivery.transport.jobId !== `outbox-${providerOutboxId}`) {
            return;
          }
          providerDeliveries += 1;
          await fetch(
            `http://127.0.0.1:${String(providerAddress.port)}/safe-effect`,
            {
              method: 'POST',
              headers: { 'idempotency-key': providerKey },
            },
          );
          const result = await consumeProof(id, logicalAttemptId, {
            attemptId: providerAttemptId,
            idempotencyKey: providerKey,
            nodeRunId: providerNodeRunId,
            outboxEventId: providerOutboxId,
            runId: providerRunId,
          });
          if (result.status !== 'duplicate') {
            throw new Error(
              'Provider delivery must follow the committed intent',
            );
          }
          await consumeInboxMessage(
            workerDatabase,
            workspaceId,
            {
              consumerName: 'worker.phase0-provider-proof',
              messageId: providerOutboxId,
              payloadChecksum: checksum({
                attemptId: providerAttemptId,
                nodeRunId: providerNodeRunId,
                runId: providerRunId,
              }),
            },
            async ({ db, workspaceId: activeWorkspaceId }) => {
              await db.execute(sql`
              update app.queue_duplicate_probe_provider_intents
              set outcome = 'accepted', completed_at = clock_timestamp()
              where id = ${providerAttemptId}
                and outcome = 'pending'
            `);
              await db.execute(sql`
              insert into app.queue_duplicate_probe_provider_effects
                (id, workspace_id, idempotency_key, outcome)
              values (
                ${randomUUID()},
                ${activeWorkspaceId},
                ${providerKey},
                'accepted'
              )
            `);
            },
          );
          providerCompleted.resolve();
        },
        observer: consumerObserver,
        queueName: QUEUE_NAME.nodeAttempts,
        redisUrl,
      });
      try {
        await Promise.all([
          producer.waitUntilReady(),
          firstCoordinator.waitUntilReady(),
        ]);
        const claimed = await rawDispatcher.claimBatch({
          leaseDurationMillis: 1_000,
          leaseOwner: 'integration-crashed',
          leaseToken: randomUUID(),
          limit: 100,
          maxAttempts: 3,
        });
        const event = claimed.events.find((candidate) => candidate.id === id);
        if (event === undefined) throw new Error('Proof event was not claimed');
        await producer.publish({
          name: JOB_NAME.advanceWorkflowRun,
          data: {
            ...(event.payload as { runId: string }),
            outboxEventId: event.id,
            schemaVersion: 1,
            workspaceId,
          },
        });
        await firstCoordinatorCommit.promise;
        await waitForRemovableJob(queue, `outbox-${id}`);
        await firstCoordinator.close();
        await queue.getJob(`outbox-${id}`).then((job) => job?.remove());
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        await Promise.all([
          secondCoordinator.waitUntilReady(),
          providerConsumer.waitUntilReady(),
        ]);
        await dispatcher.dispatchOnce();
        await Promise.all([
          duplicateCoordinatorCommit.promise,
          providerCompleted.promise,
        ]);

        expect(coordinatorDeliveries).toBe(2);
        expect(providerDeliveries).toBe(2);
        expect(receiptStatuses).toEqual(['processed', 'duplicate']);
        expect(providerRequests).toBe(2);
        expect(consumerMetrics.recordHandlerFinished).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: 'completed' }),
        );
        expect(consumerMetrics.recordHandlerFinished).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: 'failed' }),
        );
        await waitForBalancedConsumerMetrics(consumerMetrics, 4);
        const concurrencyDeltas = vi
          .mocked(consumerMetrics.addActiveConcurrency)
          .mock.calls.map(([measurement]) => measurement.delta);
        const startedHandlers = concurrencyDeltas.filter(
          (delta) => delta === 1,
        );
        const finishedHandlers = concurrencyDeltas.filter(
          (delta) => delta === -1,
        );
        expect(startedHandlers.length).toBeGreaterThanOrEqual(4);
        expect(finishedHandlers).toHaveLength(startedHandlers.length);
        expect(acceptedProviderEffects).toEqual(new Set([providerKey]));
        expect(await countLedger('queue_duplicate_probe_attempts')).toBe(1);
        expect(await countLedger('queue_duplicate_probe_events')).toBe(1);
        expect(await countLedger('queue_duplicate_probe_usage')).toBe(1);
        expect(
          await countLedger('queue_duplicate_probe_provider_effects'),
        ).toBe(1);
        const intent = await workerDatabase.withWorkspace(
          workspaceId,
          ({ db }) =>
            db.execute(sql`
            select outcome, completed_at is not null as completed
            from app.queue_duplicate_probe_provider_intents
            where id = ${providerAttemptId}
          `),
        );
        expect(intent.rows).toEqual([{ outcome: 'accepted', completed: true }]);

        const published = await apiDatabase.withWorkspace(
          workspaceId,
          ({ db }) =>
            db.select().from(outboxEvents).where(eq(outboxEvents.id, id)),
        );
        expect(published[0]?.publishedAt).toBeInstanceOf(Date);
        const otherWorkspace = randomUUID();
        await expect(
          apiDatabase.withWorkspace(otherWorkspace, ({ db }) =>
            db.select().from(outboxEvents).where(eq(outboxEvents.id, id)),
          ),
        ).resolves.toEqual([]);
        await expect(
          consumeInboxMessage(
            workerDatabase,
            otherWorkspace,
            {
              consumerName: 'worker.phase0-proof',
              messageId: id,
              payloadChecksum: checksum({ logicalAttemptId }),
            },
            () => Promise.resolve(undefined),
          ),
        ).rejects.toBeInstanceOf(InboxReceiptUnavailableError);
      } finally {
        await Promise.all([
          dispatcher.close(),
          producer.close(),
          rawDispatcher.close(),
          queue.close(),
          firstCoordinator.close(),
          secondCoordinator.close(),
          providerConsumer.close(),
        ]);
        await new Promise<void>((resolve, reject) => {
          provider.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        });
      }
    });

    it('handles concurrent duplicates, checksum conflict, and rollback atomically', async () => {
      const messageId = randomUUID();
      const logicalAttemptId = randomUUID();
      const [first, second] = await Promise.all([
        consumeProof(messageId, logicalAttemptId),
        consumeProof(messageId, logicalAttemptId),
      ]);
      expect([first.status, second.status].sort()).toEqual([
        'duplicate',
        'processed',
      ]);
      await expect(
        consumeInboxMessage(
          workerDatabase,
          workspaceId,
          {
            consumerName: 'worker.phase0-proof',
            messageId,
            payloadChecksum: '0'.repeat(64),
          },
          () => Promise.resolve(undefined),
        ),
      ).rejects.toBeInstanceOf(InboxChecksumMismatchError);

      const rollbackMessageId = randomUUID();
      await expect(
        consumeInboxMessage(
          workerDatabase,
          workspaceId,
          {
            consumerName: 'worker.rollback-proof',
            messageId: rollbackMessageId,
            payloadChecksum: checksum('rollback'),
          },
          async ({ db, workspaceId: activeWorkspaceId }) => {
            await db.execute(sql`
            insert into app.queue_duplicate_probe_attempts
              (id, workspace_id, logical_attempt_id)
            values (${randomUUID()}, ${activeWorkspaceId}, ${randomUUID()})
          `);
            throw new Error('injected rollback');
          },
        ),
      ).rejects.toThrow('injected rollback');
      await expect(
        consumeInboxMessage(
          workerDatabase,
          workspaceId,
          {
            consumerName: 'worker.rollback-proof',
            messageId: rollbackMessageId,
            payloadChecksum: checksum('rollback'),
          },
          () => Promise.resolve('recovered'),
        ),
      ).resolves.toEqual({ status: 'processed', value: 'recovered' });
    });

    it('persists unsafe ambiguity and makes Bull treat it as unrecoverable', async () => {
      const id = await insertRunEvent();
      const logicalAttemptId = randomUUID();
      const providerOutboxId = randomUUID();
      const providerAttemptId = randomUUID();
      const providerNodeRunId = randomUUID();
      const providerRunId = randomUUID();
      const providerKey = `unsafe:${logicalAttemptId}`;
      let providerRequests = 0;
      let providerDeliveries = 0;
      const provider: Server = createServer((request) => {
        providerRequests += 1;
        request.socket.destroy();
      });
      await new Promise<void>((resolve) =>
        provider.listen(0, '127.0.0.1', resolve),
      );
      const address = provider.address();
      if (address === null || typeof address === 'string')
        throw new Error('No provider');
      const dispatcher = createDispatcher('integration-unsafe');
      const coordinatorCompleted = deferred();
      const ambiguityPersisted = deferred();
      const coordinator = createQueueConsumer({
        handler: async (delivery) => {
          if (delivery.transport.jobId !== `outbox-${id}`) return;
          await consumeProof(id, logicalAttemptId, {
            attemptId: providerAttemptId,
            idempotencyKey: providerKey,
            nodeRunId: providerNodeRunId,
            outboxEventId: providerOutboxId,
            runId: providerRunId,
          });
          coordinatorCompleted.resolve();
        },
        queueName: QUEUE_NAME.workflowCoordinator,
        redisUrl,
      });
      const providerConsumer = createQueueConsumer({
        handler: async (delivery) => {
          if (delivery.transport.jobId !== `outbox-${providerOutboxId}`) {
            return;
          }
          providerDeliveries += 1;
          try {
            await fetch(`http://127.0.0.1:${String(address.port)}/unsafe`, {
              method: 'POST',
            });
          } catch (error: unknown) {
            await consumeInboxMessage(
              workerDatabase,
              workspaceId,
              {
                consumerName: 'worker.phase0-unsafe-provider-proof',
                messageId: providerOutboxId,
                payloadChecksum: checksum({
                  attemptId: providerAttemptId,
                  nodeRunId: providerNodeRunId,
                  runId: providerRunId,
                }),
              },
              async ({ db, workspaceId: activeWorkspaceId }) => {
                await db.execute(sql`
                update app.queue_duplicate_probe_provider_intents
                set outcome = 'outcome_unknown', completed_at = clock_timestamp()
                where id = ${providerAttemptId}
                  and outcome = 'pending'
              `);
                await db.execute(sql`
                insert into app.queue_duplicate_probe_provider_effects
                  (id, workspace_id, idempotency_key, outcome)
                values (
                  ${randomUUID()},
                  ${activeWorkspaceId},
                  ${providerKey},
                  'outcome_unknown'
                )
              `);
              },
            );
            ambiguityPersisted.resolve();
            throw unrecoverableQueueError(
              `unsafe provider outcome is ambiguous: ${error instanceof Error ? error.name : 'unknown'}`,
            );
          }
        },
        queueName: QUEUE_NAME.nodeAttempts,
        redisUrl,
      });
      const providerQueue = new Queue(QUEUE_NAME.nodeAttempts, {
        connection: redisConnection(),
      });
      try {
        await Promise.all([
          dispatcher.checkReadiness(),
          coordinator.waitUntilReady(),
          providerConsumer.waitUntilReady(),
        ]);
        await dispatcher.dispatchOnce();
        await coordinatorCompleted.promise;
        await dispatcher.dispatchOnce();
        await ambiguityPersisted.promise;
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        expect(providerDeliveries).toBe(1);
        expect(providerRequests).toBe(1);
        const failedJob = await providerQueue.getJob(
          `outbox-${providerOutboxId}`,
        );
        expect(failedJob?.attemptsMade).toBe(1);
        const result = await workerDatabase.withWorkspace(
          workspaceId,
          ({ db }) =>
            db.execute(sql`
          select count(*)::integer as count
          from app.queue_duplicate_probe_provider_effects
          where idempotency_key = ${providerKey}
            and outcome = 'outcome_unknown'
        `),
        );
        expect(result.rows[0]).toEqual({ count: 1 });
      } finally {
        await Promise.all([
          dispatcher.close(),
          coordinator.close(),
          providerConsumer.close(),
          providerQueue.close(),
        ]);
        await new Promise<void>((resolve, reject) => {
          provider.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        });
      }
    });
  },
);
