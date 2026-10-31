import type {
  StructuredLogger,
  TransportErrorClass,
  TransportMetrics,
} from '@pertexo/observability';
import type {
  QueueConsumerObserver,
  QueueConsumerLifecycleObservation,
  QueueDeliveryFailure,
  QueueHandlerFailureClass,
  QueueHandlerFinishedObservation,
  QueueHandlerObservation,
  QueueStallObservation,
} from '@pertexo/queue';

import { transportJobForName } from './job.js';

function transportErrorClass(
  failureClass: QueueHandlerFailureClass,
): TransportErrorClass {
  switch (failureClass) {
    case 'timeout':
      return 'timeout';
    case 'drain':
    case 'transport':
      return 'unavailable';
    case 'handler':
      return 'unknown';
  }
}

export function createQueueMetricsObserver(
  metrics: TransportMetrics,
  logger?: StructuredLogger,
): QueueConsumerObserver {
  return Object.freeze({
    deliveryFailed({ error, ...failure }: QueueDeliveryFailure): void {
      logger?.warn('queue.delivery_failed', failure, error);
    },
    consumerLifecycle(observation: QueueConsumerLifecycleObservation): void {
      metrics.recordConsumerLifecycle(observation);
    },
    handlerStarted(observation: QueueHandlerObservation): void {
      metrics.addActiveConcurrency({
        ...transportJobForName(observation.jobName),
        delta: 1,
      });
    },
    handlerFinished(observation: QueueHandlerFinishedObservation): void {
      const job = transportJobForName(observation.jobName);
      try {
        if (observation.outcome === 'completed') {
          metrics.recordHandlerFinished({
            ...job,
            durationSeconds: observation.durationSeconds,
            outcome: 'completed',
          });
        } else {
          metrics.recordHandlerFinished({
            ...job,
            durationSeconds: observation.durationSeconds,
            errorClass: transportErrorClass(observation.failureClass),
            outcome: 'failed',
          });
        }
      } finally {
        metrics.addActiveConcurrency({ ...job, delta: -1 });
      }
    },
    jobStalled(observation: QueueStallObservation): void {
      metrics.recordQueueStall(observation.queueName);
    },
  });
}
