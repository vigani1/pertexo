import type { OutboxDispatcherDatabase } from '@pertexo/core/outbox';
import type { TransportMetrics } from '@pertexo/observability';
import type { JobName, QueueProducer } from '@pertexo/queue';

import { bounded } from '../operation-deadline.js';

export function observeDispatchMetrics(observe: () => void): void {
  try {
    observe();
  } catch {
    // Operational telemetry cannot alter durable dispatch behavior.
  }
}

export async function observeDispatchQueues(
  producer: QueueProducer,
  metrics: TransportMetrics,
  {
    timeoutMillis,
    enabledQueueNames,
  }: Readonly<{
    timeoutMillis: number;
    enabledQueueNames: ReadonlySet<string>;
  }>,
): Promise<void> {
  try {
    const observations = await bounded(producer.observe(), timeoutMillis);
    observeDispatchMetrics(() => {
      for (const observation of observations) {
        if (enabledQueueNames.has(observation.queueName)) {
          metrics.observeQueue(observation);
        }
      }
    });
  } catch {
    // Queue-state telemetry is best-effort and cannot fail dispatch.
  }
}

export async function observeDispatchBacklog(
  database: OutboxDispatcherDatabase,
  metrics: TransportMetrics,
  {
    timeoutMillis,
    jobNames,
  }: Readonly<{ timeoutMillis: number; jobNames: readonly JobName[] }>,
): Promise<void> {
  try {
    const observation = await bounded(
      database.observeBacklog({
        enabledJobNames: jobNames,
      }),
      timeoutMillis,
    );
    observeDispatchMetrics(() => {
      metrics.observeOutbox(observation);
    });
  } catch {
    // Backlog telemetry is best-effort and cannot fail dispatch.
  }
}
