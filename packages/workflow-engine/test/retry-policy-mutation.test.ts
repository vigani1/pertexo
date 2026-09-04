import { describe, expect, it } from 'vitest';

import {
  decideRetry,
  ENGINE_RETRY_POLICY_V1,
  providerIdempotencyKey,
  resolveRetryPolicy,
} from '../src/testing.js';

const policy = {
  maximumAttempts: 2,
  baseDelayMs: 100,
  maximumDelayMs: 200,
  retryableErrorCodes: ['network'],
} as const;

describe('retry policy mutation canary', () => {
  it('pins every high-consequence retry decision class', () => {
    const cases = [
      [{ kind: 'success' as const }, 'unsafe', 'succeeded'],
      [
        { kind: 'definite_failure' as const, errorCode: 'network' },
        'unsafe',
        'retry',
      ],
      [
        { kind: 'definite_failure' as const, errorCode: 'authentication' },
        'safe',
        'failed',
      ],
      [
        { kind: 'ambiguous' as const, possiblyDispatched: true },
        'unsafe',
        'outcome_unknown',
      ],
      [
        { kind: 'ambiguous' as const, possiblyDispatched: true },
        'idempotent_with_key',
        'retry',
      ],
      [
        { kind: 'ambiguous' as const, possiblyDispatched: false },
        'unsafe',
        'retry',
      ],
      [
        {
          kind: 'executor_failure' as const,
          recommendation: 'canceled' as const,
          errorKind: 'canceled' as const,
          possiblyDispatched: false,
        },
        'safe',
        'failed',
      ],
      [
        {
          kind: 'executor_failure' as const,
          recommendation: 'retry' as const,
          errorKind: 'network' as const,
          possiblyDispatched: false,
        },
        'safe',
        'retry',
      ],
      [
        {
          kind: 'executor_failure' as const,
          recommendation: 'failed' as const,
          errorKind: 'network' as const,
          possiblyDispatched: false,
        },
        'safe',
        'failed',
      ],
      [
        {
          kind: 'executor_failure' as const,
          recommendation: 'retry' as const,
          errorKind: 'authentication' as const,
          possiblyDispatched: false,
        },
        'safe',
        'failed',
      ],
    ] as const;

    for (const [observation, sideEffectClass, expectedKind] of cases)
      expect(
        decideRetry({
          sideEffectClass,
          currentAttemptNumber: 1,
          policy,
          observation,
        }).kind,
        `${observation.kind}/${sideEffectClass}`,
      ).toBe(expectedKind);

    expect(
      decideRetry({
        sideEffectClass: 'safe',
        currentAttemptNumber: 2,
        policy,
        observation: { kind: 'ambiguous', possiblyDispatched: false },
      }),
    ).toEqual({ kind: 'failed', reasonCode: 'ambiguous' });
  });

  it('pins policy identity and rejects every incomplete provider identity', () => {
    expect(resolveRetryPolicy({ key: 'engine.retry', version: 1 })).toBe(
      ENGINE_RETRY_POLICY_V1,
    );
    expect(() => resolveRetryPolicy({ key: 'other', version: 1 })).toThrow(
      'Unsupported retry policy',
    );
    expect(() =>
      resolveRetryPolicy({ key: 'engine.retry', version: 2 }),
    ).toThrow('Unsupported retry policy');

    const complete = {
      namespace: 'namespace',
      runId: 'run',
      invocationKey: 'invocation',
      operationIdentity: 'operation',
    };
    for (const key of Object.keys(complete) as (keyof typeof complete)[])
      expect(() => providerIdempotencyKey({ ...complete, [key]: '' })).toThrow(
        'provider idempotency identity must be non-empty',
      );
  });
});
