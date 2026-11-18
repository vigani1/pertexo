import { describe, expect, it } from 'vitest';
import { failureNotificationCompletionDecision } from '../../src/notifications/delivery/completion-policy.js';

describe('failure notification completion decisions', () => {
  it.each([
    {
      decision: 'never retries an unsafe request after dispatch',
      row: {
        status: 'dispatching',
        side_effect_class: 'unsafe',
        possibly_dispatched: false,
      },
      possiblyDispatched: true,
      attemptNumber: 1,
      expected: {
        kind: 'terminal',
        deliveryUnresolved: true,
        status: 'outcome_unknown',
      },
    },
    {
      decision: 'retries an unsafe request known not to have dispatched',
      row: {
        status: 'claimed',
        side_effect_class: 'unsafe',
        possibly_dispatched: false,
      },
      possiblyDispatched: false,
      attemptNumber: 1,
      expected: { kind: 'retry', deliveryUnresolved: false },
    },
    {
      decision:
        'keeps unresolved idempotent delivery unknown when retries are exhausted',
      row: {
        status: 'claimed',
        side_effect_class: 'idempotent_with_key',
        possibly_dispatched: true,
      },
      possiblyDispatched: false,
      attemptNumber: 3,
      expected: {
        kind: 'terminal',
        deliveryUnresolved: true,
        status: 'outcome_unknown',
      },
    },
    {
      decision: 'dead-letters a definite failure without dispatch evidence',
      row: {
        status: 'claimed',
        side_effect_class: 'safe',
        possibly_dispatched: false,
      },
      possiblyDispatched: false,
      attemptNumber: 3,
      expected: {
        kind: 'terminal',
        deliveryUnresolved: false,
        status: 'dead_letter',
      },
    },
  ] as const)(
    '$decision',
    ({ row, possiblyDispatched, attemptNumber, expected }) => {
      expect(
        failureNotificationCompletionDecision(
          row,
          {
            kind: 'retry',
            possiblyDispatched,
            safeErrorCode: 'provider.unavailable',
          },
          attemptNumber,
          3,
        ),
      ).toEqual(expected);
    },
  );
});
