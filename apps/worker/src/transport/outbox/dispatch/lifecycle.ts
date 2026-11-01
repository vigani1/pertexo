import type { OutboxDispatcherDatabase } from '@pertexo/core/outbox';

import type { QueueProducer } from '@pertexo/queue';

import { bounded } from '../operation-deadline.js';

export async function closeDispatcherDependencies(
  database: OutboxDispatcherDatabase,
  producer: QueueProducer,
  {
    timeoutMillis,
    earlierFailures,
  }: Readonly<{ timeoutMillis: number; earlierFailures: readonly unknown[] }>,
): Promise<void> {
  const results = await Promise.allSettled([
    bounded(
      Promise.resolve().then(() => database.close()),
      timeoutMillis,
    ),
    bounded(
      Promise.resolve().then(() => producer.close()),
      timeoutMillis,
    ),
  ]);
  const failures = [
    ...earlierFailures,
    ...results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    ),
  ];
  if (failures.length > 0)
    throw new AggregateError(failures, 'Outbox dispatcher shutdown failed');
}
