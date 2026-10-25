import type { FailureNotificationDeliveryResult } from './failure-notification.js';

export interface FailureNotificationCompletionObservation {
  status: string;
  side_effect_class: string;
  possibly_dispatched: boolean | null;
}

export type CompletionDecision =
  | Readonly<{ kind: 'retry'; deliveryUnresolved: boolean }>
  | Readonly<{
      kind: 'terminal';
      deliveryUnresolved: boolean;
      status: 'delivered' | 'outcome_unknown' | 'dead_letter';
    }>;
type TerminalCompletionStatus = Extract<
  CompletionDecision,
  { readonly kind: 'terminal' }
>['status'];

function terminalCompletionStatus(
  row: FailureNotificationCompletionObservation,
  result: FailureNotificationDeliveryResult,
  {
    actuallyDispatched,
    deliveryUnresolved,
  }: Readonly<{ actuallyDispatched: boolean; deliveryUnresolved: boolean }>,
): TerminalCompletionStatus {
  if (result.kind === 'delivered') return 'delivered';
  if (actuallyDispatched || result.kind === 'outcome_unknown')
    return 'outcome_unknown';
  if (row.side_effect_class === 'idempotent_with_key' && deliveryUnresolved)
    return 'outcome_unknown';
  return 'dead_letter';
}

export function failureNotificationCompletionAuditFactType(
  status: TerminalCompletionStatus,
): 'delivered' | 'outcome_unknown' | 'dead_lettered' {
  if (status === 'delivered') return 'delivered';
  if (status === 'outcome_unknown') return 'outcome_unknown';
  return 'dead_lettered';
}

export function failureNotificationCompletionDecision(
  row: FailureNotificationCompletionObservation,
  result: FailureNotificationDeliveryResult,
  attemptNumber: number,
  maxAttempts: number,
): CompletionDecision {
  const actuallyDispatched =
    row.status === 'dispatching' && result.possiblyDispatched;
  const deliveryUnresolved =
    (row.possibly_dispatched ?? false) || actuallyDispatched;
  const retryRequested =
    result.kind === 'retry' ||
    (row.side_effect_class !== 'unsafe' && result.kind === 'outcome_unknown');
  const unsafeRetryIsKnownNotDispatched =
    row.side_effect_class !== 'unsafe' ||
    (result.kind === 'retry' && !actuallyDispatched);
  const canRetry =
    retryRequested &&
    unsafeRetryIsKnownNotDispatched &&
    attemptNumber < maxAttempts;
  if (canRetry) return { kind: 'retry', deliveryUnresolved };
  const status = terminalCompletionStatus(row, result, {
    actuallyDispatched,
    deliveryUnresolved,
  });
  return { kind: 'terminal', deliveryUnresolved, status };
}
