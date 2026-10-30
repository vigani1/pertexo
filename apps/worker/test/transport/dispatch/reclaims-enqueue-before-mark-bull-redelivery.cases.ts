import { transportMetrics } from '../../support/transport/metrics.js';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  consumeInboxMessage,
  createOutboxDispatcherDatabase,
  InboxReceiptUnavailableError,
  outboxEvents,
  parseDatabaseConfig,
} from '@pertexo/database/testing';

import { createQueueTraceRunner } from '@pertexo/observability';
import {
  createQueueConsumer,
  createQueueProducer,
  JOB_NAME,
  QUEUE_NAME,
} from '@pertexo/queue';
import type { QueueJobHandler } from '@pertexo/queue';
import { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { createQueueMetricsObserver } from '../../../src/transport/metrics-adapter.js';
import {
  closeHttpServer,
  createTransportTestCleanupStack,
  listenOnLoopback,
} from '../../support/transport.integration.support.js';
import {
  TRACEPARENT,
  apiDatabase,
  checksum,
  consumeProof,
  createDispatcher,
  deferred,
  dispatchFairRounds,
  dispatcherUrl,
  insertRunEvent,
  redisConnection,
  redisUrl,
  workerDatabase,
  workspaceId,
  claimEventAcrossFairRounds,
  waitForRemovableJob,
  waitForBalancedConsumerMetrics,
} from './fixture.js';

export function registerReclaimsEnqueueBeforeMarkBullRedelivery(): void {
  it('reclaims enqueue-before-mark and Bull redelivery becomes an inbox no-op', async () => {
    const id = await insertRunEvent(randomUUID(), TRACEPARENT);
    const logicalAttemptId = randomUUID();
    const providerOutboxId = randomUUID();
    const providerAttemptId = randomUUID();
    const providerNodeRunId = randomUUID();
    const providerRunId = randomUUID();
    const providerKey = `provider:${logicalAttemptId}`;
    const acceptedProviderEffects = new Set<string>();
    let providerRequests = 0;
    const cleanup = createTransportTestCleanupStack(
      'enqueue/redelivery provider proof',
    );
    try {
      const provider = createServer((request, response) => {
        // Other software probes new local ports (T3 Code's desktop app sends
        // `GET /`). A probe must neither count nor take the first-request drop.
        if (request.method !== 'POST' || request.url !== '/safe-effect') {
          response.writeHead(404).end();
          return;
        }
        providerRequests += 1;
        const key = String(request.headers['idempotency-key']);
        acceptedProviderEffects.add(key);
        if (providerRequests === 1) {
          request.socket.destroy();
          return;
        }
        response.writeHead(200).end();
      });
      cleanup.add('HTTP provider', () => closeHttpServer(provider));
      const providerPort = await listenOnLoopback(provider);
      const rawDispatcher = createOutboxDispatcherDatabase(
        parseDatabaseConfig({ connectionString: dispatcherUrl, max: 1 }),
      );
      cleanup.add('raw dispatcher database', () => rawDispatcher.close());
      const producer = createQueueProducer({ redisUrl });
      cleanup.add('queue producer', () => producer.close());
      const queue = new Queue(QUEUE_NAME.workflowCoordinator, {
        connection: redisConnection(),
      });
      cleanup.add('workflow coordinator queue', () => queue.close());
      const dispatcher = createDispatcher('integration-reclaimer');
      cleanup.add('outbox dispatcher', () => dispatcher.close());
      const receiptStatuses: string[] = [];
      const firstCoordinatorCommit = deferred('first coordinator commit');
      const duplicateCoordinatorCommit = deferred(
        'duplicate coordinator commit',
      );
      const providerCompleted = deferred('provider completion');
      let coordinatorDeliveries = 0;
      let providerDeliveries = 0;
      const consumerMetrics = transportMetrics();
      const consumerObserver = createQueueMetricsObserver(consumerMetrics);
      const otelTraceRunner = createQueueTraceRunner();
      const activatedTraceparents: string[] = [];
      const traceRunner = {
        run: async <T>(
          traceparent: string | undefined,
          observation: {
            readonly jobName: string;
            readonly queueName: string;
          },
          operation: () => Promise<T>,
        ): Promise<T> => {
          if (traceparent !== undefined)
            activatedTraceparents.push(traceparent);
          return otelTraceRunner.run(traceparent, observation, operation);
        },
      };
      const coordinatorHandler: QueueJobHandler = async (delivery) => {
        if (delivery.transport.jobId !== `outbox-${id}`) return;
        coordinatorDeliveries += 1;
        const result = await consumeProof(id, logicalAttemptId, {
          attemptId: providerAttemptId,
          idempotencyKey: providerKey,
          nodeRunId: providerNodeRunId,
          outboxEventId: providerOutboxId,
          runId: providerRunId,
          traceparent: TRACEPARENT,
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
        traceRunner,
      });
      const closeFirstCoordinator = cleanup.add('first coordinator', () =>
        firstCoordinator.close(),
      );
      const secondCoordinator = createQueueConsumer({
        handler: coordinatorHandler,
        observer: consumerObserver,
        queueName: QUEUE_NAME.workflowCoordinator,
        redisUrl,
        traceRunner,
      });
      cleanup.add('second coordinator', () => secondCoordinator.close());
      const providerConsumer = createQueueConsumer({
        handler: async (delivery) => {
          if (delivery.transport.jobId !== `outbox-${providerOutboxId}`) {
            return;
          }
          providerDeliveries += 1;
          await fetch(`http://127.0.0.1:${String(providerPort)}/safe-effect`, {
            method: 'POST',
            headers: { 'idempotency-key': providerKey },
            signal: AbortSignal.timeout(5_000),
          });
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
          await consumeInboxMessage(workerDatabase, workspaceId, {
            message: {
              consumerName: 'worker.phase0-provider-proof',
              messageId: providerOutboxId,
              payloadChecksum: checksum({
                attemptId: providerAttemptId,
                nodeRunId: providerNodeRunId,
                runId: providerRunId,
              }),
            },
            operation: async ({ db, workspaceId: activeWorkspaceId }) => {
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
          });
          providerCompleted.resolve();
        },
        observer: consumerObserver,
        queueName: QUEUE_NAME.nodeAttempts,
        redisUrl,
        traceRunner,
      });
      cleanup.add('provider consumer', () => providerConsumer.close());
      await Promise.all([
        producer.waitUntilReady(),
        firstCoordinator.waitUntilReady(),
      ]);
      const event = await claimEventAcrossFairRounds(rawDispatcher, id);
      await producer.publish({
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          ...(event.payload as { runId: string }),
          outboxEventId: event.id,
          workspaceId,
        },
      });
      await firstCoordinatorCommit.promise;
      await waitForRemovableJob(queue, `outbox-${id}`);
      await closeFirstCoordinator();
      await queue.getJob(`outbox-${id}`).then((job) => job?.remove());
      // This proves BullMQ/PostgreSQL lease recovery across two live workers;
      // neither boundary accepts an injected application clock.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await Promise.all([
        secondCoordinator.waitUntilReady(),
        providerConsumer.waitUntilReady(),
      ]);
      await dispatchFairRounds([dispatcher], 2);
      await Promise.all([
        duplicateCoordinatorCommit.promise,
        providerCompleted.promise,
      ]);

      expect(coordinatorDeliveries).toBe(2);
      expect(providerDeliveries).toBe(2);
      expect(receiptStatuses).toEqual(['processed', 'duplicate']);
      expect(providerRequests).toBe(2);
      expect(activatedTraceparents.length).toBeGreaterThanOrEqual(4);
      expect(new Set(activatedTraceparents)).toEqual(new Set([TRACEPARENT]));
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
      const startedHandlers = concurrencyDeltas.filter((delta) => delta === 1);
      const finishedHandlers = concurrencyDeltas.filter(
        (delta) => delta === -1,
      );
      expect(startedHandlers.length).toBeGreaterThanOrEqual(4);
      expect(finishedHandlers).toHaveLength(startedHandlers.length);
      expect(acceptedProviderEffects).toEqual(new Set([providerKey]));
      const ledger = await workerDatabase.withWorkspace(workspaceId, ({ db }) =>
        db.execute(sql`
              select
                (select count(*)::integer
                   from app.queue_duplicate_probe_attempts
                  where workspace_id=${workspaceId}
                    and logical_attempt_id=${logicalAttemptId}) attempts,
                (select count(*)::integer
                   from app.queue_duplicate_probe_events
                  where workspace_id=${workspaceId}
                    and logical_attempt_id=${logicalAttemptId}) events,
                (select count(*)::integer
                   from app.queue_duplicate_probe_usage
                  where workspace_id=${workspaceId}
                    and idempotency_key=${`usage:${logicalAttemptId}`}) usage,
                (select count(*)::integer
                   from app.queue_duplicate_probe_provider_effects
                  where workspace_id=${workspaceId}
                    and idempotency_key=${providerKey}) provider_effects
            `),
      );
      expect(ledger.rows).toEqual([
        { attempts: 1, events: 1, provider_effects: 1, usage: 1 },
      ]);
      const intent = await workerDatabase.withWorkspace(workspaceId, ({ db }) =>
        db.execute(sql`
            select outcome, completed_at is not null as completed
            from app.queue_duplicate_probe_provider_intents
            where id = ${providerAttemptId}
          `),
      );
      expect(intent.rows).toEqual([{ outcome: 'accepted', completed: true }]);

      const published = await apiDatabase.withWorkspace(workspaceId, ({ db }) =>
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
        consumeInboxMessage(workerDatabase, otherWorkspace, {
          message: {
            consumerName: 'worker.phase0-proof',
            messageId: id,
            payloadChecksum: checksum({ logicalAttemptId }),
          },
          operation: () => Promise.resolve(undefined),
        }),
      ).rejects.toBeInstanceOf(InboxReceiptUnavailableError);
    } finally {
      await cleanup.close();
    }
  });
}
