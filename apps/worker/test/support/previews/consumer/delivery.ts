import { expect } from 'vitest';

import { runWithCleanup } from '../../infrastructure/test-operation.js';

import { Queue } from 'bullmq';
import { createQueueProducer, QUEUE_NAME } from '@pertexo/queue';
import { redisUrl, redisConnectionOptions } from './environment.js';
import type {
  AcceptedDelivery,
  PreviewRuntimeReady,
  PublishedPreviewDelivery,
} from './contract.js';
import { waitFor, previewState } from './queries.js';

export async function withPublishedPreviewDelivery<T>(
  runtime: PreviewRuntimeReady,
  delivery: AcceptedDelivery,
  work: (execution: PublishedPreviewDelivery) => Promise<T>,
): Promise<T> {
  const producer = createQueueProducer({ redisUrl });
  const queue = new Queue(QUEUE_NAME.nodeAttempts, {
    connection: redisConnectionOptions(),
  });
  return runWithCleanup(
    async () => {
      await Promise.all([
        runtime.consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);
      const job = await producer.publish({
        data: delivery.job.data,
        name: delivery.job.name,
      });
      expect(job.jobId).toBe(`outbox-${delivery.accepted.outboxEventId}`);
      // A replay already has a succeeded database row. Observe this delivery's
      // consumer completion before comparing durable state, not just old success.
      const deliveredJob = await waitFor(
        () => queue.getJob(job.jobId),
        (value) => value !== undefined,
      );
      if (deliveredJob === undefined)
        throw new Error('published preview job missing');
      const deliveredState = await waitFor(
        () => deliveredJob.getState(),
        (value) => value === 'completed' || value === 'failed',
      );
      expect(deliveredState).toBe('completed');
      const state = await waitFor(
        () => previewState(delivery.accepted.previewRunId),
        (value) => value?.run_status === 'succeeded',
      );
      return work({ job, producer, queue, state });
    },
    async () => {
      const errors: unknown[] = [];
      await producer.close().catch((error: unknown) => errors.push(error));
      await queue.close().catch((error: unknown) => errors.push(error));
      if (errors.length > 0)
        throw new AggregateError(
          errors,
          'Published preview delivery cleanup failed',
        );
    },
    'Published preview delivery',
  );
}
