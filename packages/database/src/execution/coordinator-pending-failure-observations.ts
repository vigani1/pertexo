import { CoordinatorRunStateCorruptError } from './coordinator-run-store-contract.js';

export type PendingFailureRow = Readonly<{
  attempt_id: string;
  attempt_number: number;
  completed_at: Date;
  executor_error_kind: string;
  executor_failure_kind: string;
  executor_possibly_dispatched: boolean;
  invocation_key: string;
  safe_error_code: string;
}>;

export function appendPendingFailureObservations(
  observations: unknown[],
  failures: readonly PendingFailureRow[],
): void {
  const allowedFailureKinds = [
    'failed',
    'canceled',
    'retry',
    'outcome_unknown',
  ];
  const allowedErrorKinds = [
    'authentication',
    'canceled',
    'configuration',
    'internal',
    'network',
    'provider',
    'rate_limit',
    'timeout',
  ];
  for (const failure of failures) {
    if (
      !allowedFailureKinds.includes(failure.executor_failure_kind) ||
      !allowedErrorKinds.includes(failure.executor_error_kind)
    )
      throw new CoordinatorRunStateCorruptError();
    observations.push({
      kind: 'attempt_failure',
      occurredAt: failure.completed_at.toISOString(),
      invocationKey: failure.invocation_key,
      attemptId: failure.attempt_id,
      attemptNumber: failure.attempt_number,
      failureKind: failure.executor_failure_kind,
      errorKind: failure.executor_error_kind,
      possiblyDispatched: failure.executor_possibly_dispatched,
      safeErrorCode: failure.safe_error_code,
    });
  }
}
