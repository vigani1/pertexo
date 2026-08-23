import type { TransportJob } from '@pertexo/observability/transport-metrics';
import { JOB_NAME, QUEUE_FOR_JOB } from '@pertexo/queue';
import type { JobName, QueueHandlerObservation } from '@pertexo/queue';

const TRANSPORT_JOB_BY_NAME = Object.freeze({
  [JOB_NAME.advanceWorkflowRun]: {
    jobName: JOB_NAME.advanceWorkflowRun,
    queueName: QUEUE_FOR_JOB[JOB_NAME.advanceWorkflowRun],
  },
  [JOB_NAME.executeNodeAttempt]: {
    jobName: JOB_NAME.executeNodeAttempt,
    queueName: QUEUE_FOR_JOB[JOB_NAME.executeNodeAttempt],
  },
  [JOB_NAME.executePreviewAttempt]: {
    jobName: JOB_NAME.executePreviewAttempt,
    queueName: QUEUE_FOR_JOB[JOB_NAME.executePreviewAttempt],
  },
  [JOB_NAME.reconcilePreviewAttempt]: {
    jobName: JOB_NAME.reconcilePreviewAttempt,
    queueName: QUEUE_FOR_JOB[JOB_NAME.reconcilePreviewAttempt],
  },
  [JOB_NAME.sweepExpiredPreviews]: {
    jobName: JOB_NAME.sweepExpiredPreviews,
    queueName: QUEUE_FOR_JOB[JOB_NAME.sweepExpiredPreviews],
  },
  [JOB_NAME.reconcileWorkflowTriggers]: {
    jobName: JOB_NAME.reconcileWorkflowTriggers,
    queueName: QUEUE_FOR_JOB[JOB_NAME.reconcileWorkflowTriggers],
  },
  [JOB_NAME.expireArtifacts]: {
    jobName: JOB_NAME.expireArtifacts,
    queueName: QUEUE_FOR_JOB[JOB_NAME.expireArtifacts],
  },
} as const satisfies Record<JobName, TransportJob>);

export function transportJobForName(jobName: JobName): TransportJob {
  return TRANSPORT_JOB_BY_NAME[jobName];
}

export function transportJobForObservation(
  observation: QueueHandlerObservation,
): TransportJob {
  const job = transportJobForName(observation.jobName);
  if (job.queueName !== observation.queueName) {
    throw new TypeError('Queue observation has an invalid queue/job pairing');
  }
  return job;
}
