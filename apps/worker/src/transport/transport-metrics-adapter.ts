import type {
  TransportErrorClass,
  TransportMetrics,
} from '@pertexo/observability/transport-metrics';
import type {
  QueueConsumerObserver,
  QueueConsumerLifecycleObservation,
  QueueHandlerFailureClass,
  QueueHandlerFinishedObservation,
  QueueHandlerObservation,
  QueueStallObservation,
} from '@pertexo/queue';

import { transportJobForObservation } from './transport-job.js';

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
): QueueConsumerObserver {
  return Object.freeze({
    consumerLifecycle(observation: QueueConsumerLifecycleObservation): void {
      metrics.recordConsumerLifecycle(observation);
    },
    handlerStarted(observation: QueueHandlerObservation): void {
      metrics.addActiveConcurrency({
        ...transportJobForObservation(observation),
        delta: 1,
      });
    },
    handlerFinished(observation: QueueHandlerFinishedObservation): void {
      const job = transportJobForObservation(observation);
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
