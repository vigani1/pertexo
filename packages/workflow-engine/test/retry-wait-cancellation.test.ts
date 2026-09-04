import { describe, expect, it } from 'vitest';

import {
  assertAttemptTransition,
  assertNodeTransition,
  assertRunTransition,
  decideCancellation,
  decideRetry,
  planDurableWait,
  providerIdempotencyKey,
  WorkflowEngineError,
} from '../src/testing.js';

const occurredAt = '2026-08-20T10:00:00.000Z';

describe('retry, wait, cancellation, and transition policy', () => {
  const policy = {
    maximumAttempts: 3,
    baseDelayMs: 100,
    maximumDelayMs: 500,
    retryableErrorCodes: ['rate_limited', 'rate_limit', 'network'],
  } as const;

  it('uses bounded deterministic backoff and stable provider identity', () => {
    expect(
      decideRetry({
        sideEffectClass: 'idempotent_with_key',
        currentAttemptNumber: 2,
        policy,
        observation: { kind: 'definite_failure', errorCode: 'rate_limited' },
      }),
    ).toEqual({ kind: 'retry', attemptNumber: 3, delayMs: 200 });
    const input = {
      namespace: 'pertexo',
      runId: 'run',
      invocationKey: 'node',
      operationIdentity: 'http.post.v1',
    };
    expect(providerIdempotencyKey(input)).toBe(
      'v1.fc0b851d7fb6df8735e56d5cb8bb36956147162cdc1286601d755e33345c8fa1',
    );
    expect(
      providerIdempotencyKey({
        namespace: 'n'.repeat(1_000),
        runId: 'r'.repeat(1_000),
        invocationKey: 'i'.repeat(1_000),
        operationIdentity: 'o'.repeat(1_000),
      }),
    ).toHaveLength(67);
  });

  it('never retries an unsafe possibly dispatched ambiguous effect', () => {
    expect(
      decideRetry({
        sideEffectClass: 'unsafe',
        currentAttemptNumber: 1,
        policy,
        observation: { kind: 'ambiguous', possiblyDispatched: true },
      }),
    ).toEqual({
      kind: 'outcome_unknown',
      reasonCode: 'unsafe_possible_dispatch',
    });
  });

  it('applies adapter recommendations, attempt bounds, and deterministic jitter', () => {
    const input = {
      sideEffectClass: 'safe' as const,
      currentAttemptNumber: 1,
      policy,
      observation: {
        kind: 'executor_failure' as const,
        recommendation: 'retry' as const,
        errorKind: 'rate_limit' as const,
        possiblyDispatched: true,
      },
      jitterIdentity: 'run/invocation/1/engine.retry@1',
    };
    const first = decideRetry(input);
    expect(first).toEqual(decideRetry(input));
    expect(first).toMatchObject({ kind: 'retry', attemptNumber: 2 });
    if (first.kind !== 'retry') throw new Error('expected retry');
    expect(first.delayMs).toBeGreaterThanOrEqual(75);
    expect(first.delayMs).toBeLessThan(125);
    for (let index = 0; index < 100; index += 1) {
      const capped = decideRetry({
        ...input,
        currentAttemptNumber: 2,
        policy: { ...policy, baseDelayMs: 500, maximumDelayMs: 500 },
        jitterIdentity: `bounded-jitter-${String(index)}`,
      });
      if (capped.kind !== 'retry') throw new Error('expected bounded retry');
      expect(capped.delayMs).toBeLessThanOrEqual(500);
    }
    expect(
      decideRetry({
        ...input,
        currentAttemptNumber: 3,
      }),
    ).toEqual({ kind: 'failed', reasonCode: 'rate_limit' });
    expect(
      decideRetry({
        ...input,
        observation: { ...input.observation, recommendation: 'failed' },
      }),
    ).toEqual({ kind: 'failed', reasonCode: 'rate_limit' });
    expect(
      decideRetry({
        ...input,
        observation: {
          ...input.observation,
          errorKind: 'authentication',
        },
      }),
    ).toEqual({ kind: 'failed', reasonCode: 'authentication' });
  });

  it.each(['safe', 'idempotent_with_key'] as const)(
    'retries possibly-dispatched ambiguity for %s work',
    (sideEffectClass) => {
      expect(
        decideRetry({
          sideEffectClass,
          currentAttemptNumber: 1,
          policy,
          observation: {
            kind: 'executor_failure',
            recommendation: 'outcome_unknown',
            errorKind: 'network',
            possiblyDispatched: true,
          },
        }),
      ).toMatchObject({ kind: 'retry', attemptNumber: 2 });
    },
  );

  it('models a durable wait as a released slot', () => {
    expect(
      planDurableWait({
        invocationKey: 'wait',
        resumeAt: '2026-08-21T00:00:00Z',
        now: occurredAt,
      }),
    ).toEqual({
      invocationKey: 'wait',
      transition: 'waiting',
      resumeAt: '2026-08-21T00:00:00Z',
      releasesWorkerSlot: true,
    });
  });

  it('requires cancellation reconciliation and preserves unsafe uncertainty', () => {
    expect(
      decideCancellation([
        {
          invocationKey: 'a',
          nodeId: 'a',
          status: 'running',
          attemptNumber: 1,
        },
      ]),
    ).toEqual({ kind: 'await_reconciliation', invocationKeys: ['a'] });
    expect(
      decideCancellation([
        {
          invocationKey: 'unsafe',
          nodeId: 'unsafe',
          status: 'running',
          attemptNumber: 1,
          possiblyDispatched: true,
          sideEffectClass: 'unsafe',
        },
      ]),
    ).toEqual({ kind: 'outcome_unknown', invocationKeys: ['unsafe'] });
  });

  it('rejects terminal resurrection in all state machines', () => {
    expect(() => {
      assertRunTransition('succeeded', 'running');
    }).toThrow(WorkflowEngineError);
    expect(() => {
      assertNodeTransition('failed', 'ready');
    }).toThrow(WorkflowEngineError);
    expect(() => {
      assertAttemptTransition('outcome_unknown', 'running');
    }).toThrow(WorkflowEngineError);
  });
});
