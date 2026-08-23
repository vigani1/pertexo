import { createHash } from 'node:crypto';

import type { SideEffectClass } from './types.js';

export interface RetryPolicy {
  readonly maximumAttempts: number;
  readonly baseDelayMs: number;
  readonly maximumDelayMs: number;
  readonly retryableErrorCodes: readonly string[];
}

export const ENGINE_RETRY_POLICY_V1 = Object.freeze({
  reference: Object.freeze({ key: 'engine.retry', version: 1 }),
  maximumAttempts: 3,
  baseDelayMs: 1_000,
  maximumDelayMs: 60_000,
  retryableErrorCodes: Object.freeze([
    'rate_limit',
    'timeout',
    'network',
    'provider',
  ]),
} satisfies RetryPolicy & {
  readonly reference: Readonly<{ key: string; version: number }>;
});

export function resolveRetryPolicy(
  reference: Readonly<{
    key: string;
    version: number;
  }>,
): RetryPolicy {
  if (
    reference.key !== ENGINE_RETRY_POLICY_V1.reference.key ||
    reference.version !== ENGINE_RETRY_POLICY_V1.reference.version
  )
    throw new TypeError('Unsupported retry policy');
  return ENGINE_RETRY_POLICY_V1;
}

export type AttemptObservation =
  | { readonly kind: 'success' }
  | { readonly kind: 'definite_failure'; readonly errorCode: string }
  | { readonly kind: 'ambiguous'; readonly possiblyDispatched: boolean }
  | {
      readonly kind: 'executor_failure';
      readonly recommendation:
        'failed' | 'canceled' | 'retry' | 'outcome_unknown';
      readonly errorKind:
        | 'authentication'
        | 'canceled'
        | 'configuration'
        | 'internal'
        | 'network'
        | 'provider'
        | 'rate_limit'
        | 'timeout';
      readonly possiblyDispatched: boolean;
    };

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
  readonly jitterIdentity?: string;
}): RetryDecision {
  if (input.observation.kind === 'success') return { kind: 'succeeded' };
  if (
    input.observation.kind === 'executor_failure' &&
    input.observation.recommendation === 'canceled'
  )
    return { kind: 'failed', reasonCode: 'canceled' };
  if (
    (input.observation.kind === 'ambiguous' ||
      (input.observation.kind === 'executor_failure' &&
        (input.observation.recommendation === 'outcome_unknown' ||
          input.observation.recommendation === 'retry'))) &&
    input.observation.possiblyDispatched &&
    input.sideEffectClass === 'unsafe'
  ) {
    return { kind: 'outcome_unknown', reasonCode: 'unsafe_possible_dispatch' };
  }
  const errorCode =
    input.observation.kind === 'definite_failure'
      ? input.observation.errorCode
      : input.observation.kind === 'executor_failure'
        ? input.observation.errorKind
        : 'ambiguous';
  const isRetryable =
    input.observation.kind === 'ambiguous' ||
    (input.observation.kind === 'executor_failure'
      ? (input.observation.recommendation === 'retry' ||
          input.observation.recommendation === 'outcome_unknown') &&
        input.policy.retryableErrorCodes.includes(errorCode)
      : input.policy.retryableErrorCodes.includes(errorCode));
  const nextAttemptNumber = input.currentAttemptNumber + 1;
  if (!isRetryable || nextAttemptNumber > input.policy.maximumAttempts) {
    return { kind: 'failed', reasonCode: errorCode };
  }
  const exponent = Math.max(0, input.currentAttemptNumber - 1);
  const boundedDelay = Math.min(
    input.policy.maximumDelayMs,
    input.policy.baseDelayMs * 2 ** exponent,
  );
  const jitter =
    input.jitterIdentity === undefined
      ? 1
      : 0.75 +
        createHash('sha256')
          .update(input.jitterIdentity, 'utf8')
          .digest()
          .readUInt32BE(0) /
          0x1_0000_0000 /
          2;
  return {
    kind: 'retry',
    attemptNumber: nextAttemptNumber,
    delayMs: Math.min(
      input.policy.maximumDelayMs,
      Math.floor(boundedDelay * jitter),
    ),
  };
}

export function providerIdempotencyKey(input: {
  readonly namespace: string;
  readonly runId: string;
  readonly invocationKey: string;
  readonly operationIdentity: string;
}): string {
  if (
    !input.namespace ||
    !input.runId ||
    !input.invocationKey ||
    !input.operationIdentity
  )
    throw new TypeError('provider idempotency identity must be non-empty');
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        invocationKey: input.invocationKey,
        namespace: input.namespace,
        operationIdentity: input.operationIdentity,
        runId: input.runId,
      }),
      'utf8',
    )
    .digest('hex');
  return `v1.${digest}`;
}
