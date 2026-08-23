import './server-only.js';

export const QUEUE_NAME = Object.freeze({
  workflowCoordinator: 'workflow-coordinator',
  nodeAttempts: 'node-attempts',
  triggerLifecycle: 'trigger-lifecycle',
  maintenance: 'maintenance',
} as const);

export type QueueName = (typeof QUEUE_NAME)[keyof typeof QUEUE_NAME];

export const JOB_NAME = Object.freeze({
  advanceWorkflowRun: 'advance-workflow-run',
  executeNodeAttempt: 'execute-node-attempt',
  executePreviewAttempt: 'execute-preview-attempt',
  reconcileWorkflowTriggers: 'reconcile-workflow-triggers',
  expireArtifacts: 'expire-artifacts',
  sweepExpiredPreviews: 'sweep-expired-previews',
} as const);

export type JobName = (typeof JOB_NAME)[keyof typeof JOB_NAME];
export type QueueJobName = JobName;

export const QUEUE_FOR_JOB = Object.freeze({
  [JOB_NAME.advanceWorkflowRun]: QUEUE_NAME.workflowCoordinator,
  [JOB_NAME.executeNodeAttempt]: QUEUE_NAME.nodeAttempts,
  [JOB_NAME.executePreviewAttempt]: QUEUE_NAME.nodeAttempts,
  [JOB_NAME.reconcileWorkflowTriggers]: QUEUE_NAME.triggerLifecycle,
  [JOB_NAME.expireArtifacts]: QUEUE_NAME.maintenance,
  [JOB_NAME.sweepExpiredPreviews]: QUEUE_NAME.maintenance,
} as const satisfies Record<JobName, QueueName>);
