import type {
  LeasedOutboxEvent,
  OutboxDispatcherDatabase,
} from '@pertexo/core/outbox';
import type { TransportMetrics } from '@pertexo/observability';

import { bounded } from '../operation-deadline.js';
import {
  canNeverPublish,
  errorCode,
  publicationRetryDelay,
} from './delivery.js';
import { observeDispatchMetrics } from './observations.js';

/** Gives a failed publication back: to retry later, or for good if it can never publish. */
export async function releaseFailedPublication(
  {
    database,
    metrics,
  }: Readonly<{
    database: OutboxDispatcherDatabase;
    metrics: TransportMetrics;
  }>,
  event: LeasedOutboxEvent,
  error: unknown,
  options: Readonly<{
    operationTimeoutMillis: number;
    retryDelayMillis: number;
  }>,
): Promise<void> {
  const releaseResult = await bounded(
    database.releaseOrFail({
      errorCode: errorCode(error),
      id: event.id,
      leaseToken: event.leaseToken,
      ...(canNeverPublish(error)
        ? { disposition: 'fail' as const }
        : {
            disposition: 'retry' as const,
            retryAt: new Date(
              Date.now() +
                publicationRetryDelay(
                  options.retryDelayMillis,
                  event.publishAttempts,
                ),
            ),
          }),
    }),
    options.operationTimeoutMillis,
  );
  if (releaseResult === 'failed') {
    observeDispatchMetrics(() => {
      metrics.recordOutboxLeaseEvent('publication_failed');
    });
  } else if (releaseResult === 'not_leased') {
    observeDispatchMetrics(() => {
      metrics.recordOutboxLeaseEvent('expired');
    });
  }
}
