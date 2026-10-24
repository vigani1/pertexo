import { expect, it } from 'vitest';

import {
  auditFailureNotification,
  insertFailureNotificationDeliveryOutbox,
  workspaceId,
  intentId,
  type LockedIntent,
  completionHarness,
} from './fixture.js';

export function registerCompletionPolicy(): void {
  it.each([
    {
      scenario: 'safe retry with attempts remaining',
      row: {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'safe',
        status: 'claimed',
      } satisfies LockedIntent,
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
      } satisfies LockedIntent,
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
      } satisfies LockedIntent,
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
      } satisfies LockedIntent,
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
      } satisfies LockedIntent,
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
      } satisfies LockedIntent,
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
      } satisfies LockedIntent,
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
      } satisfies LockedIntent,
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
      } satisfies LockedIntent,
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
      } satisfies LockedIntent,
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
    async ({
      row,
      result,
      maxAttempts,
      expectedStatus,
      expectedUnresolved,
    }) => {
      const { complete } = completionHarness(row);

      await expect(
        complete({
          workspaceId,
          intentId,
          attemptNumber: row.delivery_attempts,
          maxAttempts,
          retryDelaySeconds: 5,
          result: { ...result },
        }),
      ).resolves.toBe('completed');

      if (expectedStatus === 'retry') {
        expect(insertFailureNotificationDeliveryOutbox).toHaveBeenCalledWith(
          expect.anything(),
          {
            attemptNumber: row.delivery_attempts + 1,
            availableAt: new Date('2026-09-11T00:00:00.000Z'),
            intentId,
            workspaceId,
          },
        );
        expect(auditFailureNotification).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            attemptNumber: row.delivery_attempts,
            factType: 'retry_scheduled',
            intentId,
            possiblyDispatched: expectedUnresolved,
            workspaceId,
          }),
        );
      } else {
        expect(insertFailureNotificationDeliveryOutbox).not.toHaveBeenCalled();
        let factType;
        if (expectedStatus === 'delivered') {
          factType = 'delivered';
        } else {
          if (expectedStatus === 'outcome_unknown') {
            factType = 'outcome_unknown';
          } else {
            factType = 'dead_lettered';
          }
        }
        expect(auditFailureNotification).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            attemptNumber: row.delivery_attempts,
            factType: factType,
            intentId,
            possiblyDispatched: expectedUnresolved,
            workspaceId,
          }),
        );
      }
    },
  );
}
