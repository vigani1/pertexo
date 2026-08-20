import type { SideEffectClass } from './types.js';

export interface RetryPolicy {
  readonly maximumAttempts: number;
  readonly baseDelayMs: number;
  readonly maximumDelayMs: number;
  readonly retryableErrorCodes: readonly string[];
}

export type AttemptObservation =
  | { readonly kind: 'success' }
  | { readonly kind: 'definite_failure'; readonly errorCode: string }
  | { readonly kind: 'ambiguous'; readonly possiblyDispatched: boolean };

export type RetryDecision =
  | { readonly kind: 'succeeded' }
  | { readonly kind: 'failed'; readonly reasonCode: string }
  | {
      readonly kind: 'outcome_unknown';
      readonly reasonCode: 'unsafe_possible_dispatch';
    }
  | {
      readonly kind: 'retry';
      readonly attemptNumber: number;
      readonly delayMs: number;
    };

export function decideRetry(input: {
  readonly sideEffectClass: SideEffectClass;
  readonly currentAttemptNumber: number;
  readonly policy: RetryPolicy;
  readonly observation: AttemptObservation;
}): RetryDecision {
  if (input.observation.kind === 'success') return { kind: 'succeeded' };
  if (
    input.observation.kind === 'ambiguous' &&
    input.observation.possiblyDispatched &&
    input.sideEffectClass === 'unsafe'
  ) {
    return { kind: 'outcome_unknown', reasonCode: 'unsafe_possible_dispatch' };
  }
  const errorCode =
    input.observation.kind === 'definite_failure'
      ? input.observation.errorCode
      : 'ambiguous';
  const isRetryable =
    input.observation.kind === 'ambiguous' ||
    input.policy.retryableErrorCodes.includes(errorCode);
  const nextAttemptNumber = input.currentAttemptNumber + 1;
  if (!isRetryable || nextAttemptNumber > input.policy.maximumAttempts) {
    return { kind: 'failed', reasonCode: errorCode };
  }
  const exponent = Math.max(0, input.currentAttemptNumber - 1);
  return {
    kind: 'retry',
    attemptNumber: nextAttemptNumber,
    delayMs: Math.min(
      input.policy.maximumDelayMs,
      input.policy.baseDelayMs * 2 ** exponent,
    ),
  };
}

export function providerIdempotencyKey(input: {
  readonly namespace: string;
  readonly runId: string;
  readonly invocationKey: string;
  readonly operationIdentity: string;
}): string {
  const raw = [
    input.namespace,
    input.runId,
    input.invocationKey,
    input.operationIdentity,
  ]
    .map(encodeURIComponent)
    .join('.');
  return `v1.${raw}`;
}
