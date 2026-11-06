import type { StepRetrySettings } from '@pertexo/workflow-model';
import { decideRetry, type RetryPolicy } from '../attempt/retries.js';
import type {
  RecoveryAttempt,
  RecoveryNode,
} from './workflow-recovery.types.js';

export function completeFailure(
  attempt: RecoveryAttempt,
): attempt is RecoveryAttempt & {
  failureKind: 'failed' | 'retry' | 'outcome_unknown';
  errorKind: NonNullable<RecoveryAttempt['errorKind']>;
  possiblyDispatched: boolean;
} {
  return (
    (attempt.status === 'failed' || attempt.status === 'outcome_unknown') &&
    (attempt.failureKind === 'failed' ||
      attempt.failureKind === 'retry' ||
      attempt.failureKind === 'outcome_unknown') &&
    attempt.errorKind !== null &&
    attempt.possiblyDispatched !== null
  );
}

export function completeAttempts(node: RecoveryNode): boolean {
  const incompleteAttemptCount =
    node.currentAttemptNumber === null ||
    node.currentAttemptNumber < 1 ||
    node.attempts.length !== node.currentAttemptNumber;
  if (incompleteAttemptCount) return false;
  for (const [index, attempt] of node.attempts.entries()) {
    if (attempt.number !== index + 1) return false;
    const invalidPriorAttempt =
      index < node.attempts.length - 1 &&
      (!completeFailure(attempt) ||
        attempt.status !== 'failed' ||
        attempt.retryDecision !== 'retry');
    if (invalidPriorAttempt) return false;
  }
  const current = node.attempts.at(-1);
  return (
    current?.id === node.currentAttemptId &&
    (current.status === node.status ||
      (node.status === 'outcome_unknown' && current.status === 'failed'))
  );
}

export function retryOutcome(
  node: RecoveryNode,
  attempt: RecoveryAttempt,
  policy: RetryPolicy,
  settings?: StepRetrySettings,
) {
  if (!completeFailure(attempt)) return undefined;
  return decideRetry({
    sideEffectClass: node.sideEffectClass,
    currentAttemptNumber: attempt.number,
    policy,
    settings,
    observation: {
      kind: 'executor_failure',
      recommendation: attempt.failureKind,
      errorKind: attempt.errorKind,
      possiblyDispatched: attempt.possiblyDispatched,
    },
  });
}
