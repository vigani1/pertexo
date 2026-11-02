import {
  beforeEachFixture1,
  auditFailureNotification,
  insertFailureNotificationDeliveryOutbox,
  workspaceId,
  intentId,
  completionHarness,
  type LockedIntent,
} from './completion-store/fixture.js';
import { beforeEach, describe, expect, it } from 'vitest';

describe('failure notification completion policy', () => {
  beforeEach(beforeEachFixture1);
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

  it('accepts zero retry delay for terminal completion but rejects it before retry mutation', async () => {
    const terminal = completionHarness({
      delivery_attempts: 10,
      possibly_dispatched: false,
      side_effect_class: 'safe',
      status: 'dispatching',
    });
    await expect(
      terminal.complete({
        workspaceId,
        intentId,
        attemptNumber: 10,
        maxAttempts: 10,
        retryDelaySeconds: 0,
        result: {
          kind: 'retry',
          possiblyDispatched: false,
          safeErrorCode: 'provider.exhausted',
        },
      }),
    ).resolves.toBe('completed');

    const retry = completionHarness({
      delivery_attempts: 1,
      possibly_dispatched: false,
      side_effect_class: 'safe',
      status: 'dispatching',
    });
    await expect(
      retry.complete({
        workspaceId,
        intentId,
        attemptNumber: 1,
        maxAttempts: 10,
        retryDelaySeconds: 0,
        result: {
          kind: 'retry',
          possiblyDispatched: false,
          safeErrorCode: 'provider.unavailable',
        },
      }),
    ).rejects.toThrow('Retry delay must be positive');
    expect(retry.query).toHaveBeenCalledOnce();
  });

  it('accepts the maximum retry delay and attempt-control boundaries', async () => {
    const maximumDelay = completionHarness({
      delivery_attempts: 1,
      possibly_dispatched: false,
      side_effect_class: 'safe',
      status: 'claimed',
    });
    await expect(
      maximumDelay.complete({
        workspaceId,
        intentId,
        attemptNumber: 1,
        maxAttempts: 10,
        retryDelaySeconds: 3_600,
        result: {
          kind: 'retry',
          possiblyDispatched: false,
          safeErrorCode: 'provider.unavailable',
        },
      }),
    ).resolves.toBe('completed');
    expect(insertFailureNotificationDeliveryOutbox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptNumber: 2 }),
    );

    const minimumMaximum = completionHarness({
      delivery_attempts: 1,
      possibly_dispatched: false,
      side_effect_class: 'safe',
      status: 'claimed',
    });
    await expect(
      minimumMaximum.complete({
        workspaceId,
        intentId,
        attemptNumber: 1,
        maxAttempts: 1,
        retryDelaySeconds: 0,
        result: {
          kind: 'retry',
          possiblyDispatched: false,
          safeErrorCode: 'provider.exhausted',
        },
      }),
    ).resolves.toBe('completed');
    expect(auditFailureNotification).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ factType: 'dead_lettered', attemptNumber: 1 }),
    );
  });

  it.each([
    ['missing intent', undefined, 1],
    [
      'terminal intent',
      {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'safe',
        status: 'delivered',
      },
      1,
    ],
    [
      'older attempt',
      {
        delivery_attempts: 2,
        possibly_dispatched: false,
        side_effect_class: 'safe',
        status: 'dispatching',
      },
      1,
    ],
    [
      'newer attempt',
      {
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'safe',
        status: 'dispatching',
      },
      2,
    ],
  ] as const)(
    'returns stale for $0 without mutation',
    async (_label, row, attemptNumber) => {
      const { complete, query } = completionHarness(row);
      await expect(
        complete({
          workspaceId,
          intentId,
          attemptNumber,
          maxAttempts: 3,
          retryDelaySeconds: 5,
          result: {
            kind: 'retry',
            possiblyDispatched: false,
            safeErrorCode: 'provider.unavailable',
          },
        }),
      ).resolves.toBe('stale');
      expect(query).toHaveBeenCalledOnce();
      expect(auditFailureNotification).not.toHaveBeenCalled();
      expect(insertFailureNotificationDeliveryOutbox).not.toHaveBeenCalled();
    },
  );

  it('rejects a pre-aborted completion before client work', async () => {
    const controller = new AbortController();
    const reason = new Error('completion canceled');
    controller.abort(reason);
    const { complete, query } = completionHarness({
      delivery_attempts: 1,
      possibly_dispatched: false,
      side_effect_class: 'safe',
      status: 'dispatching',
    });
    await expect(
      complete({
        workspaceId,
        intentId,
        attemptNumber: 1,
        maxAttempts: 3,
        retryDelaySeconds: 5,
        result: {
          kind: 'retry',
          possiblyDispatched: false,
          safeErrorCode: 'provider.unavailable',
        },
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: 'delivered' as const,
      possiblyDispatched: true,
      providerReference: 'provider-message-1',
    },
    {
      kind: 'outcome_unknown' as const,
      possiblyDispatched: true,
      safeErrorCode: 'provider.ambiguous',
    },
  ] as const)(
    'rejects incompatible claimed $kind completion before mutation',
    async (result) => {
      const { complete, query } = completionHarness({
        delivery_attempts: 1,
        possibly_dispatched: false,
        side_effect_class: 'safe',
        status: 'claimed',
      });

      await expect(
        complete({
          workspaceId,
          intentId,
          attemptNumber: 1,
          maxAttempts: 3,
          retryDelaySeconds: 5,
          result: { ...result },
        }),
      ).rejects.toThrow('Predispatch completion result is incompatible');
      expect(query).toHaveBeenCalledOnce();
      expect(auditFailureNotification).not.toHaveBeenCalled();
      expect(insertFailureNotificationDeliveryOutbox).not.toHaveBeenCalled();
    },
  );
});
