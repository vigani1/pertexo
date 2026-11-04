import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import {
  describeIntegration,
  prepareWorkerPostgreSQLRedisTransportProofFixture,
  closeWorkerPostgreSQLRedisTransportProofFixture,
  apiDatabase,
  checksum,
  createDispatcher,
  deferred,
  dispatchFairRounds,
  insertRunEvent,
  redisConnection,
  redisUrl,
  workspaceId,
  TRACEPARENT,
  consumeProof,
  dispatcherUrl,
  workerDatabase,
  claimEventAcrossFairRounds,
  waitForRemovableJob,
  waitForBalancedConsumerMetrics,
} from './dispatch.fixture.js';
import { randomUUID } from 'node:crypto';
import {
  insertOutboxEvent,
  outboxEvents,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import {
  createQueueConsumer,
  JOB_NAME,
  QUEUE_NAME,
  createQueueProducer,
  type QueueJobHandler,
} from '@pertexo/queue';
import { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import {
  createTransportTestCleanupStack,
  closeHttpServer,
  listenOnLoopback,
} from '../support/transport.integration.support.js';
import { transportMetrics } from '../support/transport/metrics.js';
import { createServer } from 'node:http';
import {
  consumeInboxMessage,
  createOutboxDispatcherDatabase,
  InboxReceiptUnavailableError,
} from '@pertexo/core/testing';
import { createQueueTraceRunner } from '@pertexo/observability';
import { createQueueMetricsObserver } from '../../src/transport/metrics-adapter.js';

describeIntegration(
  'worker PostgreSQL + Redis transport proof',
  { concurrent: false },
  () => {
    beforeAll(prepareWorkerPostgreSQLRedisTransportProofFixture);
    afterAll(closeWorkerPostgreSQLRedisTransportProofFixture);
    it('publishes every target outbox ID under two-dispatcher concurrency', async () => {
      const ids = await Promise.all(
        Array.from({ length: 4 }, () => insertRunEvent()),
      );
      const cleanup = createTransportTestCleanupStack(
        'two-dispatcher concurrency proof',
      );
      try {
        const first = createDispatcher('integration-a', 2);
        cleanup.add('first dispatcher', () => first.close());
        const second = createDispatcher('integration-b', 2);
        cleanup.add('second dispatcher', () => second.close());
        await Promise.all([first.checkReadiness(), second.checkReadiness()]);
        const result = await dispatchFairRounds([first, second], ids.length);
        expect(result).toMatchObject({ failed: 0 });
        expect(result.claimed).toBeGreaterThanOrEqual(ids.length);
        expect(result.published).toBeGreaterThanOrEqual(ids.length);
        const queue = new Queue(QUEUE_NAME.workflowCoordinator, {
          connection: redisConnection(),
        });
        cleanup.add('workflow coordinator queue', () => queue.close());
        const jobs = await Promise.all(
          ids.map((id) => queue.getJob(`outbox-${id}`)),
        );
        expect(jobs.every((job) => job !== undefined)).toBe(true);
      } finally {
        await cleanup.close();
      }
    });

    it('dispatches only the job kinds the worker consumes and holds the rest', async () => {
      const enabledId = await insertRunEvent();
      const heldId = randomUUID();
      const payload = {
        publishedVersionId: randomUUID(),
        workflowId: randomUUID(),
      };
      await apiDatabase.withWorkspace(workspaceId, (transaction) =>
        insertOutboxEvent(transaction, {
          aggregateId: payload.workflowId,
          aggregateType: 'workflow',
          availableAt: new Date(0),
          id: heldId,
          jobName: JOB_NAME.reconcileWorkflowTriggers,
          payload,
          payloadChecksum: checksum(payload),
        }).then(() => undefined),
      );
      const consumerStarted = deferred('ready consumer started');
      const releaseConsumer = deferred('ready consumer released');
      const cleanup = createTransportTestCleanupStack('consumed job kinds');
      try {
        const enabledQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
          connection: redisConnection(),
        });
        cleanup.add('enabled queue', () => enabledQueue.close());
        const heldQueue = new Queue(QUEUE_NAME.triggerLifecycle, {
          connection: redisConnection(),
        });
        cleanup.add('held queue', () => heldQueue.close());
        const consumer = createQueueConsumer({
          handler: async (delivery) => {
            if (delivery.data.outboxEventId !== enabledId) return;
            consumerStarted.resolve();
            await releaseConsumer.promise;
          },
          queueName: QUEUE_NAME.workflowCoordinator,
          redisUrl,
        });
        cleanup.add('ready consumer', () => consumer.close());
        const dispatcher = createDispatcher(
          'integration-consumed-job-kinds',
          100,
          [JOB_NAME.advanceWorkflowRun],
        );
        cleanup.add('enabled dispatcher', () => dispatcher.close());
        await dispatcher.checkReadiness();
        await expect(
          dispatchFairRounds([dispatcher], 1),
        ).resolves.toMatchObject({
          claimed: 1,
          published: 1,
        });
        await expect(
          enabledQueue.getJob(`outbox-${enabledId}`),
        ).resolves.toBeDefined();
        await expect(
          heldQueue.getJob(`outbox-${heldId}`),
        ).resolves.toBeUndefined();
        await consumerStarted.promise;

        const held = await apiDatabase.withWorkspace(workspaceId, ({ db }) =>
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
      } finally {
        releaseConsumer.resolve();
        await cleanup.close();
      }
    });

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
            throw new Error(
              'injected crash after coordinator commit before ack',
            );
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
            await fetch(
              `http://127.0.0.1:${String(providerPort)}/safe-effect`,
              {
                method: 'POST',
                headers: { 'idempotency-key': providerKey },
                signal: AbortSignal.timeout(5_000),
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
        const startedHandlers = concurrencyDeltas.filter(
          (delta) => delta === 1,
        );
        const finishedHandlers = concurrencyDeltas.filter(
          (delta) => delta === -1,
        );
        expect(startedHandlers.length).toBeGreaterThanOrEqual(4);
        expect(finishedHandlers).toHaveLength(startedHandlers.length);
        expect(acceptedProviderEffects).toEqual(new Set([providerKey]));
        const ledger = await workerDatabase.withWorkspace(
          workspaceId,
          ({ db }) =>
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
  },
);
