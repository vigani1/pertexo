import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CoordinatorRunStateCorruptError } from '../src/runs/advance/contract.js';
import {
  appendPendingFailureObservations,
  type PendingFailureRow,
} from '../src/runs/advance/pending-failures.js';
import { safeErrorCodeSchema } from '../src/execution/node-attempts/node-attempt-run-store-contract.js';

const valid = (): PendingFailureRow => ({
  attempt_id: randomUUID(),
  attempt_number: 1,
  completed_at: new Date('2026-09-13T00:00:00.000Z'),
  executor_error_kind: 'network',
  executor_failure_kind: 'retry',
  executor_possibly_dispatched: false,
  invocation_key: 'version/node|b:|i:',
  safe_error_code: 'provider.unavailable',
});

describe('pending coordinator failure observations', () => {
  it.each(['provider.unavailable', 'Provider.Failure', '9Provider:Failure'])(
    'round-trips every writer-accepted code shape: %s',
    (safeErrorCode) => {
      expect(safeErrorCodeSchema.parse(safeErrorCode)).toBe(safeErrorCode);
      const observations: unknown[] = [];
      appendPendingFailureObservations(observations, [
        { ...valid(), safe_error_code: safeErrorCode },
      ]);
      expect(observations).toEqual([
        expect.objectContaining({ safeErrorCode }),
      ]);
    },
  );

  it.each(['failed', 'canceled', 'retry', 'outcome_unknown'])(
    'preserves each executor failure kind: %s',
    (failureKind) => {
      const observations: unknown[] = [];
      appendPendingFailureObservations(observations, [
        { ...valid(), executor_failure_kind: failureKind },
      ]);
      expect(observations).toEqual([expect.objectContaining({ failureKind })]);
    },
  );

  it.each([
    'authentication',
    'canceled',
    'configuration',
    'internal',
    'network',
    'provider',
    'rate_limit',
    'timeout',
  ])('preserves each executor error kind: %s', (errorKind) => {
    const observations: unknown[] = [];
    appendPendingFailureObservations(observations, [
      { ...valid(), executor_error_kind: errorKind },
    ]);
    expect(observations).toEqual([expect.objectContaining({ errorKind })]);
  });

  it.each(['', 'Private Message', 'provider/invalid', `x${'a'.repeat(128)}`])(
    'rejects invalid codes at both seams: %s',
    (safeErrorCode) => {
      expect(safeErrorCodeSchema.safeParse(safeErrorCode).success).toBe(false);
      expect(() => {
        appendPendingFailureObservations(
          [],
          [{ ...valid(), safe_error_code: safeErrorCode }],
        );
      }).toThrow(CoordinatorRunStateCorruptError);
    },
  );

  it('projects the exact finite persisted tuple', () => {
    const observations: unknown[] = [];
    const row = valid();
    appendPendingFailureObservations(observations, [row]);
    expect(observations).toEqual([
      {
        kind: 'attempt_failure',
        occurredAt: '2026-09-13T00:00:00.000Z',
        invocationKey: row.invocation_key,
        attemptId: row.attempt_id,
        attemptNumber: 1,
        failureKind: 'retry',
        errorKind: 'network',
        possiblyDispatched: false,
        safeErrorCode: 'provider.unavailable',
      },
    ]);
  });

  it.each([
    { completed_at: new Date(Number.NaN) },
    { completed_at: '2026-09-13T00:00:00.000Z' },
    { attempt_id: 'not-a-uuid' },
    { attempt_number: 0 },
    { attempt_number: Number.NaN },
    { executor_failure_kind: 'invented' },
    { executor_error_kind: 'invented' },
    { executor_possibly_dispatched: null },
    { invocation_key: '' },
    { safe_error_code: 'Private Message' },
  ])('fails closed for malformed tuple %#', (override) => {
    const observations: unknown[] = [];
    expect(() => {
      appendPendingFailureObservations(observations, [
        { ...valid(), ...override } as PendingFailureRow,
      ]);
    }).toThrow(CoordinatorRunStateCorruptError);
    expect(observations).toEqual([]);
  });
});
