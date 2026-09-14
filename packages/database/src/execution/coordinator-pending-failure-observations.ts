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
  const allowedFailureKinds: readonly string[] = [
    'failed',
    'canceled',
    'retry',
    'outcome_unknown',
  ];
  const allowedErrorKinds: readonly string[] = [
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
      !(failure.completed_at instanceof Date) ||
      !Number.isFinite(failure.completed_at.getTime()) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        failure.attempt_id,
      ) ||
      !Number.isSafeInteger(failure.attempt_number) ||
      failure.attempt_number < 1 ||
      typeof failure.executor_possibly_dispatched !== 'boolean' ||
      typeof failure.invocation_key !== 'string' ||
      Buffer.byteLength(failure.invocation_key, 'utf8') < 1 ||
      Buffer.byteLength(failure.invocation_key, 'utf8') > 256 ||
      !/^[a-z][a-z0-9._:-]{0,127}$/u.test(failure.safe_error_code) ||
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
