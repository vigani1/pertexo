import { randomUUID } from 'node:crypto';

import {
  NodeExecutorFailure,
  type NodeExecutorErrorKind,
  type NodeExecutorFailureOutcome,
} from '@pertexo/node-sdk/server';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { parsePersistedObservation } from '../../src/observation/persisted-parser.js';

// Every failure an executor may raise must be accepted when the engine reads
// it back from storage; otherwise the run's coordinator stalls on it.
const failureKinds = [
  'failed',
  'canceled',
  'retry',
  'outcome_unknown',
] as const;
const errorKinds = [
  'authentication',
  'canceled',
  'configuration',
  'internal',
  'network',
  'provider',
  'rate_limit',
  'timeout',
] as const;

describe('persisted executor failures follow the node-sdk failure contract', () => {
  it('lists every failure and error kind node-sdk declares', () => {
    expectTypeOf<(typeof failureKinds)[number]>().toEqualTypeOf<
      NodeExecutorFailureOutcome['kind']
    >();
    expectTypeOf<
      (typeof errorKinds)[number]
    >().toEqualTypeOf<NodeExecutorErrorKind>();
    expect(failureKinds).toHaveLength(4);
    expect(errorKinds).toHaveLength(8);
  });

  it.each(
    failureKinds.flatMap((kind) =>
      errorKinds.map((errorKind) => [kind, errorKind] as const),
    ),
  )('reads back a %s %s failure', (kind, errorKind) => {
    const raised = new NodeExecutorFailure({
      kind,
      errorKind,
      possiblyDispatched: false,
    });
    expect(
      parsePersistedObservation(persisted(raised.kind, raised.errorKind)),
    ).toMatchObject({ failureKind: kind, errorKind });
  });

  it('refuses an error kind outside the contract on both sides', () => {
    expect(
      () =>
        new NodeExecutorFailure({
          kind: 'retry',
          errorKind: 'quota' as NodeExecutorErrorKind,
          possiblyDispatched: false,
        }),
    ).toThrow();
    expect(() =>
      parsePersistedObservation(persisted('retry', 'quota')),
    ).toThrow(expect.objectContaining({ code: 'observation_invalid' }));
  });

  // docs/guides/step-retries.md: a service's Retry-After can lengthen a wait
  // "up to one minute".
  it('bounds a requested retry delay at one minute on both sides', () => {
    expect(
      new NodeExecutorFailure({
        kind: 'retry',
        errorKind: 'rate_limit',
        possiblyDispatched: false,
        minimumRetryDelayMillis: 60_000,
      }).minimumRetryDelayMillis,
    ).toBe(60_000);
    expect(
      parsePersistedObservation({
        ...persisted('retry', 'rate_limit'),
        minimumRetryDelayMillis: 60_000,
      }),
    ).toMatchObject({ minimumRetryDelayMillis: 60_000 });
    expect(
      () =>
        new NodeExecutorFailure({
          kind: 'retry',
          errorKind: 'rate_limit',
          possiblyDispatched: false,
          minimumRetryDelayMillis: 60_001,
        }),
    ).toThrow();
    expect(() =>
      parsePersistedObservation({
        ...persisted('retry', 'rate_limit'),
        minimumRetryDelayMillis: 60_001,
      }),
    ).toThrow(expect.objectContaining({ code: 'observation_invalid' }));
  });
});

function persisted(failureKind: string, errorKind: string) {
  return {
    kind: 'attempt_failure',
    occurredAt: '2026-10-30T00:00:00.000Z',
    invocationKey: 'node',
    attemptId: randomUUID(),
    attemptNumber: 1,
    failureKind,
    errorKind,
    possiblyDispatched: false,
    safeErrorCode: `execution.${errorKind}`,
  };
}
