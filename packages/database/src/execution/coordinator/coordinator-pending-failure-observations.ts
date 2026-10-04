import type { PoolClient } from 'pg';
import { CoordinatorRunStateCorruptError } from './coordinator-run-store-contract.js';
import { isSafeExecutorErrorCode } from '@pertexo/workflow-model/attempt-failure';

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
      !isSafeExecutorErrorCode(failure.safe_error_code) ||
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

/** Read current physical pending failures and append their validated semantic facts. */
export async function loadPendingFailureObservations(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  observations: unknown[],
): Promise<void> {
  const pendingFailures = await client.query<PendingFailureRow>(
    `select attempt.id attempt_id,attempt.attempt_number,
                attempt.completed_at,attempt.executor_failure_kind,
                attempt.executor_error_kind,
                attempt.executor_possibly_dispatched,
                attempt.safe_error_code,node.invocation_key
         from app.node_attempts attempt
         join app.node_runs node
           on node.workspace_id=attempt.workspace_id
          and node.id=attempt.node_run_id
         where attempt.workspace_id=$1 and node.workflow_run_id=$2
           and node.current_attempt_id=attempt.id
           and node.current_attempt_number=attempt.attempt_number
           and node.status='running' and attempt.status='failed'
           and attempt.retry_decision='pending'
         order by node.invocation_key,attempt.id`,
    [workspaceId, runId],
  );
  appendPendingFailureObservations(observations, pendingFailures.rows);
}
