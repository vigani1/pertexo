import { describe, expect, it } from 'vitest';
import {
  attemptReconciliationOutcome,
  automaticReconciliationAction,
} from '../../src/attempts/attempt-reconciliation.js';
describe('attempt reconciliation', () => {
  const attempt = {
    status: 'running',
    fenceToken: 3,
    leaseExpired: true,
    dispatchMarkedAt: null as Date | null,
    sideEffectClass: 'safe',
  };
  const reclaim = {
    expectedFenceToken: 3,
    action: 'reclaim' as const,
    dryRun: false,
  };
  it('keeps fencing, lease expiry and unsafe dispatch ahead of reconciliation', () => {
    expect(attemptReconciliationOutcome(undefined, reclaim)).toBe('not_found');
    expect(
      attemptReconciliationOutcome({ ...attempt, status: 'ready' }, reclaim),
    ).toBe('not_running');
    expect(
      attemptReconciliationOutcome(attempt, {
        ...reclaim,
        expectedFenceToken: 4,
      }),
    ).toBe('fence_conflict');
    for (const leaseExpired of [false, null])
      expect(
        attemptReconciliationOutcome({ ...attempt, leaseExpired }, reclaim),
      ).toBe('lease_active');
    const unsafe = {
      ...attempt,
      sideEffectClass: 'unsafe',
      dispatchMarkedAt: new Date(),
    };
    expect(attemptReconciliationOutcome(unsafe, reclaim)).toBe(
      'reclaim_unsafe',
    );
    expect(
      attemptReconciliationOutcome(unsafe, {
        ...reclaim,
        action: 'outcome_unknown',
      }),
    ).toBe('marked_unknown');
    expect(attemptReconciliationOutcome(attempt, reclaim)).toBe('reclaimed');
    expect(
      attemptReconciliationOutcome(attempt, { ...reclaim, dryRun: true }),
    ).toBe('would_reclaim');
    expect(
      attemptReconciliationOutcome(unsafe, {
        ...reclaim,
        action: 'outcome_unknown',
        dryRun: true,
      }),
    ).toBe('would_mark_unknown');
  });
});

describe('automaticReconciliationAction', () => {
  const at = new Date('2026-10-31T00:00:00.000Z');

  it.each([
    [at, 'unsafe', 'outcome_unknown'],
    [null, 'unsafe', 'reclaim'],
    [at, 'safe', 'reclaim'],
    [at, 'idempotent_with_key', 'reclaim'],
  ] as const)(
    'with dispatch %s and class %s asks for %s',
    (dispatchMarkedAt, sideEffectClass, action) => {
      expect(
        automaticReconciliationAction({ dispatchMarkedAt, sideEffectClass }),
      ).toBe(action);
    },
  );

  // Every expired attempt has to end up settled; a refusal here would strand it.
  it.each([
    [at, 'safe', 'reclaimed'],
    [at, 'idempotent_with_key', 'reclaimed'],
    [at, 'unsafe', 'marked_unknown'],
    [null, 'safe', 'reclaimed'],
    [null, 'idempotent_with_key', 'reclaimed'],
    [null, 'unsafe', 'reclaimed'],
  ] as const)(
    'settles an expired attempt with dispatch %s and class %s as %s',
    (dispatchMarkedAt, sideEffectClass, outcome) => {
      expect(
        attemptReconciliationOutcome(
          {
            status: 'running',
            fenceToken: 3,
            leaseExpired: true,
            dispatchMarkedAt,
            sideEffectClass,
          },
          {
            expectedFenceToken: 3,
            action: automaticReconciliationAction({
              dispatchMarkedAt,
              sideEffectClass,
            }),
            dryRun: false,
          },
        ),
      ).toBe(outcome);
    },
  );

  it('leaves alone what another worker has already settled', () => {
    const action = automaticReconciliationAction({
      dispatchMarkedAt: at,
      sideEffectClass: 'safe',
    });
    const settled = {
      status: 'ready',
      fenceToken: 4,
      leaseExpired: null,
      dispatchMarkedAt: at,
      sideEffectClass: 'safe',
    };
    expect(
      attemptReconciliationOutcome(settled, {
        expectedFenceToken: 3,
        action,
        dryRun: false,
      }),
    ).toBe('not_running');
    expect(
      attemptReconciliationOutcome(
        { ...settled, status: 'running', leaseExpired: true },
        { expectedFenceToken: 3, action, dryRun: false },
      ),
    ).toBe('fence_conflict');
  });
});
