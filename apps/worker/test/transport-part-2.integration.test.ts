import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import {
  consumeInboxMessage,
  InboxChecksumMismatchError,
  insertOutboxEvent,
} from '@pertexo/database/testing';
import {
  createQueueConsumer,
  JOB_NAME,
  QUEUE_NAME,
  unrecoverableQueueError,
} from '@pertexo/queue';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { createWorkerTransportTestEnvironment } from './support/transport.integration.support.js';

const integration = process.env.WORKER_TRANSPORT_INTEGRATION === 'true';
const describeIntegration = integration ? describe : describe.skip;
const transport = createWorkerTransportTestEnvironment();
const {
  checksum,
  createDispatcher,
  deferred,
  insertRunEvent,
  redisConnection,
  redisUrl,
  workerDatabase,
  workspaceId,
} = transport;

async function consumeProof(
  messageId: string,
  logicalAttemptId: string,
  providerIntent?: Readonly<{
    attemptId: string;
    idempotencyKey: string;
    nodeRunId: string;
    outboxEventId: string;
    runId: string;
    traceparent?: string;
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
          ...(providerIntent.traceparent
            ? { traceparent: providerIntent.traceparent }
            : {}),
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

async function dispatchFairRounds(
  dispatchers: readonly ReturnType<typeof createDispatcher>[],
  expectedClaims: number,
): Promise<Readonly<{ claimed: number; failed: number; published: number }>> {
  const totals = { claimed: 0, failed: 0, published: 0 };
  const maximumRounds = expectedClaims + 2;
  for (let round = 0; round < maximumRounds; round += 1) {
    const results = await Promise.all(
      dispatchers.map((dispatcher) => dispatcher.dispatchOnce()),
    );
    for (const result of results) {
      totals.claimed += result.claimed;
      totals.failed += result.failed;
      totals.published += result.published;
    }
    if (totals.claimed >= expectedClaims) return totals;
  }
  throw new Error(
    `Fair dispatch did not claim ${String(expectedClaims)} events within ${String(maximumRounds)} rounds: ${JSON.stringify(totals)}`,
  );
}

describeIntegration(
  'worker PostgreSQL + Redis transport proof',
  { concurrent: false },
  () => {
    beforeAll(transport.initialize);
    afterAll(transport.close);

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
