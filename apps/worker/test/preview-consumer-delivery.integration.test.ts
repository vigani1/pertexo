import { randomUUID } from 'node:crypto';

import {
  canonicalOutboxPayloadChecksum,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { platformServingRegistryRelease } from '@pertexo/node-catalog';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import { createQueueProducer } from '@pertexo/queue';
import { Queue } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { createNodeAttemptRuntime } from '../src/execution/node-attempt-runtime.js';
import {
  createDatabasePreviewAttemptRunStore,
  createPlatformPreviewNodeInvoker,
} from '../src/execution/preview-attempt-runtime.js';
import {
  acceptDelivery,
  databaseUrl,
  deliveryJobData,
  previewState,
  redisUrl,
  validTraceparent,
  waitFor,
  withTenantScopedWorker,
  workerTransportIntegrationEnabled,
  workerUrl,
} from './support/preview-consumer.integration.support.js';

const describeIntegration = workerTransportIntegrationEnabled
  ? describe
  : describe.skip;

describeIntegration('preview delivery transport', () => {
  it('executes an accepted preview through BullMQ once and duplicates safely', async () => {
    const delivery = await acceptDelivery(validTraceparent(1));
    const previewStore = createDatabasePreviewAttemptRunStore(
      parseDatabaseConfig({ connectionString: databaseUrl(workerUrl) }),
    );
    const registry = createPlatformNodeRegistryForRelease(
      platformServingRegistryRelease('core'),
    );
    const runtime = await createNodeAttemptRuntime({
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
      }),
      heartbeatIntervalMillis: 200,
      leaseDurationSeconds: 10,
      preview: {
        invoker: createPlatformPreviewNodeInvoker({
          releaseCohort: 'core',
          registry,
        }),
        runStore: previewStore,
      },
      redisUrl,
      releaseCohort: 'core',
      workerId: `preview-transport-${randomUUID().slice(0, 8)}`,
    });
    const producer = createQueueProducer({ redisUrl });
    const queue = new Queue('node-attempts', {
      connection: (() => {
        const parsed = new URL(redisUrl);
        return {
          db: Number(parsed.pathname.slice(1)),
          host: parsed.hostname,
          port: Number(parsed.port || 6379),
          ...(parsed.password === ''
            ? {}
            : { password: decodeURIComponent(parsed.password) }),
        };
      })(),
    });
    try {
      await Promise.all([
        runtime.consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);
      const job = await producer.publish({
        data: delivery.job.data,
        name: delivery.job.name,
      });
      expect(job.jobId).toBe(`outbox-${delivery.accepted.outboxEventId}`);

      const state = await waitFor(
        () => previewState(delivery.accepted.previewRunId),
        (value) => value?.run_status === 'succeeded',
      );
      expect(state?.attempt_fence).toBe('1');
      // core.set is a safe node: dispatch evidence is not required before
      // its pure execution, so no marker exists for this preview.
      expect(state?.dispatch_marked_at).toBeNull();
      expect(JSON.parse(String(state?.output_ref))).toMatchObject({
        value: { hello: 'transport' },
      });

      const receipts = await withTenantScopedWorker((client) =>
        client.query<{ count: string; completed: string }>(
          `select count(*)::text as count,
                  count(completed_at)::text as completed
           from app.inbox_receipts
           where consumer_name='preview-attempt-worker' and message_id=$1`,
          [delivery.accepted.outboxEventId],
        ),
      );
      expect(receipts.rows[0]).toEqual({ completed: '1', count: '1' });

      // Exact redelivery of the published job must not re-execute: the
      // durable outcome, fence, and receipt stay untouched.
      const before = await previewState(delivery.accepted.previewRunId);
      const completedJob = await waitFor(
        () => queue.getJob(job.jobId),
        (value) => value !== undefined,
      );
      if (completedJob === undefined)
        throw new Error('completed preview job missing');
      await waitFor(
        () => completedJob.getState(),
        (state) => state === 'completed',
      );
      await completedJob.remove();
      const replayed = await producer.publish({
        data: delivery.job.data,
        name: delivery.job.name,
      });
      const replayedJob = await waitFor(
        () => queue.getJob(replayed.jobId),
        (value) => value !== undefined,
      );
      if (replayedJob === undefined)
        throw new Error('redelivered preview job missing');
      await waitFor(
        () => replayedJob.getState(),
        (state) => state === 'completed',
      );
      const after = await previewState(delivery.accepted.previewRunId);
      expect(after).toEqual(before);
      expect(after?.attempt_fence).toBe('1');
    } finally {
      await Promise.allSettled([
        runtime.close(),
        producer.close(),
        queue.close(),
      ]);
    }

    // The checksum helper stays exercised so drift between transport bytes
    // and the durable aggregate fails this suite loudly.
    expect(
      canonicalOutboxPayloadChecksum({
        ...deliveryJobData(delivery),
      }),
    ).toBe(canonicalOutboxPayloadChecksum(deliveryJobData(delivery)));
  });
});
