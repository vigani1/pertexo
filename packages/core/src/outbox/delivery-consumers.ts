/**
 * Who confirms each job kind, by writing an inbox receipt under the event's ID in
 * the transaction that takes the work on. A published event with no receipt is
 * still somebody's promise, so `stalled work` delivers it again.
 */
export const DELIVERY_CONSUMER = Object.freeze({
  'advance-workflow-run': 'workflow-coordinator',
  'apply-connection-health-observation': 'connection-health-worker',
  'deliver-run-failure-notification': 'run-failure-notification',
  'deliver-workspace-invitation': 'workspace-invitation',
  'execute-node-attempt': 'node-attempt-worker',
  'execute-preview-attempt': 'preview-attempt-worker',
  'reconcile-preview-attempt': 'preview-attempt-reconciler',
  'reconcile-workflow-triggers': 'trigger-runtime.reconciliation',
  'replay-workflow-run': 'operator-run-replay',
  'start-error-workflow': 'error-workflow',
} as const);

/** The job kinds a stranded run depends on, and which can be rebuilt from it. */
export const RUN_DELIVERY_JOB_NAMES = [
  'advance-workflow-run',
  'execute-node-attempt',
] as const;

/** Owners other than runs reconcile their own failed delivery identity. */
export const REPAIRABLE_DELIVERY_JOB_NAMES = [
  ...RUN_DELIVERY_JOB_NAMES,
  'start-error-workflow',
] as const;
