import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import {
  consumeInboxMessage,
  InboxChecksumMismatchError,
} from '@pertexo/database/testing';
import {
  createQueueConsumer,
  QUEUE_NAME,
  unrecoverableQueueError,
} from '@pertexo/queue';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import {
  closeHttpServer,
  createTransportTestCleanupStack,
  createWorkerTransportTestEnvironment,
  listenOnLoopback,
} from './support/transport.integration.support.js';

const integration = process.env.WORKER_TRANSPORT_INTEGRATION === 'true';
const describeIntegration = integration ? describe : describe.skip;
type TransportEnvironment = ReturnType<
  typeof createWorkerTransportTestEnvironment
>;
let transport: TransportEnvironment;
let checksum: TransportEnvironment['checksum'];
let consumeProof: TransportEnvironment['consumeProof'];
let createDispatcher: TransportEnvironment['createDispatcher'];
let deferred: TransportEnvironment['deferred'];
let dispatchFairRounds: TransportEnvironment['dispatchFairRounds'];
let insertRunEvent: TransportEnvironment['insertRunEvent'];
let redisConnection: TransportEnvironment['redisConnection'];
let redisUrl: TransportEnvironment['redisUrl'];
let workerDatabase: TransportEnvironment['workerDatabase'];
let workspaceId: TransportEnvironment['workspaceId'];

describeIntegration(
  'worker receipt atomicity and unsafe-delivery proof',
  { concurrent: false },
  () => {
    beforeAll(async () => {
      transport = createWorkerTransportTestEnvironment();
      await transport.initialize();
      ({
        checksum,
        consumeProof,
        createDispatcher,
        deferred,
        dispatchFairRounds,
        insertRunEvent,
        redisConnection,
        redisUrl,
        workerDatabase,
        workspaceId,
      } = transport);
    });
    afterAll(async () => transport.close());

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
      const rolledBackAttemptId = randomUUID();
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
            values (${rolledBackAttemptId}, ${activeWorkspaceId}, ${randomUUID()})
          `);
            throw new Error('injected rollback');
          },
        ),
      ).rejects.toThrow('injected rollback');
      await expect(
        workerDatabase.withWorkspace(workspaceId, ({ db }) =>
          db.execute(sql`
            select id
            from app.queue_duplicate_probe_attempts
            where id = ${rolledBackAttemptId}
          `),
        ),
      ).resolves.toMatchObject({ rows: [] });
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
      const cleanup = createTransportTestCleanupStack(
        'unsafe provider ambiguity proof',
      );
      try {
        const provider = createServer((request) => {
          providerRequests += 1;
          request.socket.destroy();
        });
        cleanup.add('HTTP provider', () => closeHttpServer(provider));
        const providerPort = await listenOnLoopback(provider);
        const dispatcher = createDispatcher('integration-unsafe');
        cleanup.add('outbox dispatcher', () => dispatcher.close());
        const coordinatorCompleted = deferred('unsafe coordinator completion');
        const ambiguityPersisted = deferred('unsafe ambiguity persistence');
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
        cleanup.add('workflow coordinator', () => coordinator.close());
        const providerConsumer = createQueueConsumer({
          handler: async (delivery) => {
            if (delivery.transport.jobId !== `outbox-${providerOutboxId}`) {
              return;
            }
            providerDeliveries += 1;
            try {
              await fetch(`http://127.0.0.1:${String(providerPort)}/unsafe`, {
                method: 'POST',
                signal: AbortSignal.timeout(5_000),
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
        cleanup.add('provider consumer', () => providerConsumer.close());
        const providerQueue = new Queue(QUEUE_NAME.nodeAttempts, {
          connection: redisConnection(),
        });
        cleanup.add('provider queue', () => providerQueue.close());
        await Promise.all([
          dispatcher.checkReadiness(),
          coordinator.waitUntilReady(),
          providerConsumer.waitUntilReady(),
        ]);
        await dispatchFairRounds([dispatcher], 1);
        await coordinatorCompleted.promise;
        await dispatchFairRounds([dispatcher], 1);
        await ambiguityPersisted.promise;
        // Observe the real BullMQ retry window to prove an ambiguous provider
        // outcome is not retried by the transport.
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
        await cleanup.close();
      }
    });
  },
);
