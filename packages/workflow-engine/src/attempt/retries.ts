import { createHash } from 'node:crypto';
import {
  MAXIMUM_RETRY_DELAY_MILLIS,
  type NodeExecutorErrorKind,
  type NodeExecutorFailureKind,
} from '@pertexo/node-sdk/server';
import type { StepRetrySettings } from '@pertexo/workflow-model';

import type { SideEffectClass } from '../types.js';

export interface RetryPolicy {
  readonly maximumAttempts: number;
  readonly baseDelayMs: number;
  readonly maximumDelayMs: number;
  readonly retryableErrorCodes: readonly string[];
}

export const ENGINE_RETRY_POLICY = Object.freeze({
  reference: Object.freeze({ key: 'engine.retry', version: 1 }),
  maximumAttempts: 3,
  baseDelayMs: 1_000,
  maximumDelayMs: MAXIMUM_RETRY_DELAY_MILLIS,
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
    reference.key !== ENGINE_RETRY_POLICY.reference.key ||
    reference.version !== ENGINE_RETRY_POLICY.reference.version
  )
    throw new TypeError('Unsupported retry policy');
  return ENGINE_RETRY_POLICY;
}

export type AttemptObservation =
  | { readonly kind: 'success' }
  | { readonly kind: 'definite_failure'; readonly errorCode: string }
  | { readonly kind: 'ambiguous'; readonly possiblyDispatched: boolean }
  | {
      readonly kind: 'executor_failure';
      readonly recommendation: NodeExecutorFailureKind;
      readonly errorKind: NodeExecutorErrorKind;
      readonly possiblyDispatched: boolean;
      readonly minimumRetryDelayMillis?: number;
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

interface RetryInput {
  readonly sideEffectClass: SideEffectClass;
  readonly currentAttemptNumber: number;
  readonly policy: RetryPolicy;
  readonly settings?: StepRetrySettings | undefined;
  readonly observation: AttemptObservation;
  readonly jitterIdentity?: string;
}

export function decideRetry(input: RetryInput): RetryDecision {
  if (input.observation.kind === 'success') return { kind: 'succeeded' };
  if (
    input.observation.kind === 'executor_failure' &&
    input.observation.recommendation === 'canceled'
  )
    return { kind: 'failed', reasonCode: 'canceled' };
  if (mayHaveUnsafeEffect(input))
    return { kind: 'outcome_unknown', reasonCode: 'unsafe_possible_dispatch' };
  const errorCode = retryErrorCode(input.observation);
  const isRetryable = observationAllowsRetry(
    input.observation,
    input.policy,
    errorCode,
  );
  const nextAttemptNumber = input.currentAttemptNumber + 1;
  if (
    !isRetryable ||
    nextAttemptNumber >
      (input.settings?.maximumAttempts ?? input.policy.maximumAttempts)
  ) {
    return { kind: 'failed', reasonCode: errorCode };
  }
  const exponent = Math.max(0, input.currentAttemptNumber - 1);
  const boundedDelay =
    input.settings?.delayMillis ??
    Math.min(
      input.policy.maximumDelayMs,
      input.policy.baseDelayMs * 2 ** exponent,
    );
  const jitter =
    input.settings !== undefined || input.jitterIdentity === undefined
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
      Math.max(
        Math.floor(boundedDelay * jitter),
        input.observation.kind === 'executor_failure'
          ? (input.observation.minimumRetryDelayMillis ?? 0)
          : 0,
      ),
    ),
  };
}

export function providerIdempotencyKey(input: {
  readonly namespace: string;
  readonly runId: string;
  readonly invocationKey: string;
  readonly operationIdentity: string;
}): string {
  const missingIdempotencyIdentity =
    !input.namespace ||
    !input.runId ||
    !input.invocationKey ||
    !input.operationIdentity;
  if (missingIdempotencyIdentity)
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

function mayHaveUnsafeEffect(input: RetryInput): boolean {
  const observation = input.observation;
  const uncertain =
    observation.kind === 'ambiguous' ||
    (observation.kind === 'executor_failure' &&
      (observation.recommendation === 'outcome_unknown' ||
        observation.recommendation === 'retry'));
  return (
    uncertain &&
    observation.possiblyDispatched &&
    input.sideEffectClass === 'unsafe'
  );
}
function retryErrorCode(observation: AttemptObservation): string {
  if (observation.kind === 'definite_failure') return observation.errorCode;
  if (observation.kind === 'executor_failure') return observation.errorKind;
  return 'ambiguous';
}
function observationAllowsRetry(
  observation: AttemptObservation,
  policy: RetryPolicy,
  errorCode: string,
): boolean {
  if (observation.kind === 'ambiguous') return true;
  if (observation.kind === 'executor_failure') {
    const recommended =
      observation.recommendation === 'retry' ||
      observation.recommendation === 'outcome_unknown';
    return recommended && policy.retryableErrorCodes.includes(errorCode);
  }
  return policy.retryableErrorCodes.includes(errorCode);
}
