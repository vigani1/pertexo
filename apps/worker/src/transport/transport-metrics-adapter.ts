import type {
  TransportErrorClass,
  TransportMetrics,
  TransportJob,
} from '@pertexo/observability/transport-metrics';
import { JOB_NAME, QUEUE_NAME } from '@pertexo/queue';
import type {
  QueueConsumerObserver,
  QueueHandlerFailureClass,
  QueueHandlerFinishedObservation,
  QueueHandlerObservation,
} from '@pertexo/queue';

function transportJob(observation: QueueHandlerObservation): TransportJob {
  switch (observation.jobName) {
    case JOB_NAME.advanceWorkflowRun:
      if (observation.queueName !== QUEUE_NAME.workflowCoordinator) break;
      return {
        jobName: JOB_NAME.advanceWorkflowRun,
        queueName: QUEUE_NAME.workflowCoordinator,
      };
    case JOB_NAME.executeNodeAttempt:
      if (observation.queueName !== QUEUE_NAME.nodeAttempts) break;
      return {
        jobName: JOB_NAME.executeNodeAttempt,
        queueName: QUEUE_NAME.nodeAttempts,
      };
    case JOB_NAME.reconcileWorkflowTriggers:
      if (observation.queueName !== QUEUE_NAME.triggerLifecycle) break;
      return {
        jobName: JOB_NAME.reconcileWorkflowTriggers,
        queueName: QUEUE_NAME.triggerLifecycle,
      };
    case JOB_NAME.expireArtifacts:
      if (observation.queueName !== QUEUE_NAME.maintenance) break;
      return {
        jobName: JOB_NAME.expireArtifacts,
        queueName: QUEUE_NAME.maintenance,
      };
  }

  throw new TypeError('Queue observation has an invalid queue/job pairing');
}

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
    handlerStarted(observation: QueueHandlerObservation): void {
      metrics.addActiveConcurrency({
        ...transportJob(observation),
        delta: 1,
      });
    },
    handlerFinished(observation: QueueHandlerFinishedObservation): void {
      const job = transportJob(observation);
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
  });
}
