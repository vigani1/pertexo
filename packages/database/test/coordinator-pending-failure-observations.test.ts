import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CoordinatorRunStateCorruptError } from '../src/execution/coordinator-run-store-contract.js';
import {
  appendPendingFailureObservations,
  type PendingFailureRow,
} from '../src/execution/coordinator-pending-failure-observations.js';

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
