import type { PendingCoordinatorFailure } from './state.js';

/** A failed attempt awaiting its retry decision, as the engine observes it. */
export function pendingFailureObservations(
  failures: readonly PendingCoordinatorFailure[],
): readonly unknown[] {
  return failures.map((failure) => ({
    kind: 'attempt_failure',
    occurredAt: failure.completed_at.toISOString(),
    invocationKey: failure.invocation_key,
    attemptId: failure.attempt_id,
    attemptNumber: failure.attempt_number,
    failureKind: failure.executor_failure_kind,
    errorKind: failure.executor_error_kind,
    possiblyDispatched: failure.executor_possibly_dispatched,
    safeErrorCode: failure.safe_error_code,
  }));
}
