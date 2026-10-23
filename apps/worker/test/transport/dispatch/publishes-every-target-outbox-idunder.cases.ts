import { randomUUID } from 'node:crypto';

import { insertOutboxEvent, outboxEvents } from '@pertexo/database/testing';

import { createQueueConsumer, JOB_NAME, QUEUE_NAME } from '@pertexo/queue';

import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { createTransportTestCleanupStack } from '../../support/transport.integration.support.js';
import {
  apiDatabase,
  checksum,
  createDispatcher,
  deferred,
  dispatchFairRounds,
  insertRunEvent,
  redisConnection,
  redisUrl,
  workspaceId,
} from './fixture.js';

export function registerPublishesEveryTargetOutboxIDUnder(): void {
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
      await expect(dispatchFairRounds([dispatcher], 1)).resolves.toMatchObject({
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
}
