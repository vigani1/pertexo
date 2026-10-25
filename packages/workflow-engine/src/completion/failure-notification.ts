import type { WorkflowCheckpoint } from '../types.js';

/** Most uncertain failures explain a notification before definite failures. */
export function notificationFailures(checkpoint: WorkflowCheckpoint) {
  return checkpoint.invocations
    .filter(({ status }) =>
      ['failed', 'timed_out', 'outcome_unknown'].includes(status),
    )
    .sort((left, right) => {
      const severity = { outcome_unknown: 0, timed_out: 1, failed: 2 } as const;
      const statusOrder =
        severity[left.status as keyof typeof severity] -
        severity[right.status as keyof typeof severity];
      return (
        statusOrder || left.invocationKey.localeCompare(right.invocationKey)
      );
    });
}
