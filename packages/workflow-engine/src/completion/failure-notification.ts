import type { WorkflowCheckpoint } from '../types.js';

/** A failure its handler took care of didn't fail the run, so it explains nothing. */
export function wasHandled(
  invocation: WorkflowCheckpoint['invocations'][number],
): boolean {
  return invocation.failureHandling?.disposition === 'handled';
}

/** Most uncertain failures explain a notification before definite failures. */
export function notificationFailures(checkpoint: WorkflowCheckpoint) {
  return checkpoint.invocations
    .filter(
      (invocation) =>
        ['failed', 'timed_out', 'outcome_unknown'].includes(
          invocation.status,
        ) && !wasHandled(invocation),
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
