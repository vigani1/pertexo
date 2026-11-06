import type {
  LeasedOutboxEvent,
  OutboxDispatcherDatabase,
} from '@pertexo/core/outbox';
import type {
  StructuredLogger,
  TransportMetrics,
} from '@pertexo/observability/server';

import { bounded } from '../operation-deadline.js';
import {
  canNeverPublish,
  errorCode,
  publicationRetryDelay,
  publicationRefusalDiagnostics,
} from './delivery.js';
import { observeDispatchMetrics } from './observations.js';

/** Gives a failed publication back: to retry later, or for good if it can never publish. */
export async function releaseFailedPublication(
  {
    database,
    metrics,
    logger,
  }: Readonly<{
    database: OutboxDispatcherDatabase;
    metrics: TransportMetrics;
    logger?: StructuredLogger | undefined;
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
            retryDelayMillis: publicationRetryDelay(
              options.retryDelayMillis,
              event.publishAttempts,
            ),
          }),
    }),
    options.operationTimeoutMillis,
  );
  if (releaseResult === 'failed') {
    if (canNeverPublish(error))
      logger?.error('outbox.publication_refused', {
        eventId: event.id,
        workspaceId: event.workspaceId,
        jobName: event.jobName,
        errorCode: errorCode(error),
        ...publicationRefusalDiagnostics(error),
      });
    observeDispatchMetrics(() => {
      metrics.recordOutboxLeaseEvent('publication_failed');
    });
  } else if (releaseResult === 'not_leased') {
    observeDispatchMetrics(() => {
      metrics.recordOutboxLeaseEvent('expired');
    });
  }
}
