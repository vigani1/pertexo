import { describe, expect, it } from 'vitest';
import { failureNotificationCompletionDecision } from '../../src/execution/notification-completion.js';

describe('notification completion policy examples', () => {
  it.each([
    {
      scenario: 'safe retry with attempts remaining',
      row: {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'safe',
        status: 'claimed',
      },
      result: {
        kind: 'retry' as const,
        possiblyDispatched: false,
        safeErrorCode: 'provider.unavailable',
      },
      maxAttempts: 3,
      expectedStatus: 'retry',
      expectedUnresolved: false,
    },
    {
      scenario: 'unsafe predispatch retry with attempts remaining',
      row: {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'unsafe',
        status: 'claimed',
      },
      result: {
        kind: 'retry' as const,
        possiblyDispatched: false,
        safeErrorCode: 'provider.unavailable',
      },
      maxAttempts: 3,
      expectedStatus: 'retry',
      expectedUnresolved: false,
    },
    {
      scenario: 'safe ambiguous dispatch remains retryable',
      row: {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'safe',
        status: 'dispatching',
      },
      result: {
        kind: 'outcome_unknown' as const,
        possiblyDispatched: true,
        safeErrorCode: 'provider.ambiguous',
      },
      maxAttempts: 3,
      expectedStatus: 'retry',
      expectedUnresolved: true,
    },
    {
      scenario: 'idempotent ambiguous dispatch remains retryable',
      row: {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'idempotent_with_key',
        status: 'dispatching',
      },
      result: {
        kind: 'outcome_unknown' as const,
        possiblyDispatched: true,
        safeErrorCode: 'provider.ambiguous',
      },
      maxAttempts: 3,
      expectedStatus: 'retry',
      expectedUnresolved: true,
    },
    {
      scenario: 'unsafe retry after dispatch becomes unknown',
      row: {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'unsafe',
        status: 'dispatching',
      },
      result: {
        kind: 'retry' as const,
        possiblyDispatched: true,
        safeErrorCode: 'provider.unavailable',
      },
      maxAttempts: 3,
      expectedStatus: 'outcome_unknown',
      expectedUnresolved: true,
    },
    {
      scenario:
        'defensive corrupt-state policy preserves prior uncertainty on a claimed unsafe row',
      row: {
        delivery_attempts: 1,
        possibly_dispatched: true,
        side_effect_class: 'unsafe',
        status: 'claimed',
      },
      result: {
        kind: 'retry' as const,
        possiblyDispatched: false,
        safeErrorCode: 'provider.unavailable',
      },
      maxAttempts: 3,
      expectedStatus: 'retry',
      expectedUnresolved: true,
    },
    {
      scenario: 'delivered dispatch',
      row: {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'idempotent_with_key',
        status: 'dispatching',
      },
      result: {
        kind: 'delivered' as const,
        possiblyDispatched: true,
        providerReference: 'provider-message-1',
      },
      maxAttempts: 3,
      expectedStatus: 'delivered',
      expectedUnresolved: true,
    },
    {
      scenario: 'unsafe ambiguous dispatch',
      row: {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'unsafe',
        status: 'dispatching',
      },
      result: {
        kind: 'outcome_unknown' as const,
        possiblyDispatched: true,
        safeErrorCode: 'provider.ambiguous',
      },
      maxAttempts: 3,
      expectedStatus: 'outcome_unknown',
      expectedUnresolved: true,
    },
    {
      scenario: 'exhausted safe retry',
      row: {
        delivery_attempts: 3,
        possibly_dispatched: false,
        side_effect_class: 'safe',
        status: 'dispatching',
      },
      result: {
        kind: 'retry' as const,
        possiblyDispatched: false,
        safeErrorCode: 'provider.unavailable',
      },
      maxAttempts: 3,
      expectedStatus: 'dead_letter',
      expectedUnresolved: false,
    },
    {
      scenario: 'exhausted idempotent delivery with prior uncertainty',
      row: {
        delivery_attempts: 3,
        possibly_dispatched: true,
        side_effect_class: 'idempotent_with_key',
        status: 'dispatching',
      },
      result: {
        kind: 'retry' as const,
        possiblyDispatched: false,
        safeErrorCode: 'provider.unavailable',
      },
      maxAttempts: 3,
      expectedStatus: 'outcome_unknown',
      expectedUnresolved: true,
    },
  ] as const)(
    '$scenario',
    ({ row, result, maxAttempts, expectedStatus, expectedUnresolved }) => {
      expect(
        failureNotificationCompletionDecision(
          row,
          result,
          row.delivery_attempts,
          maxAttempts,
        ),
      ).toEqual(
        expectedStatus === 'retry'
          ? { kind: 'retry', deliveryUnresolved: expectedUnresolved }
          : {
              kind: 'terminal',
              status: expectedStatus,
              deliveryUnresolved: expectedUnresolved,
            },
      );
    },
  );
});
