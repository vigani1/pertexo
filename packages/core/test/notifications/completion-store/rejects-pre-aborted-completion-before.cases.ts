import { expect, it } from 'vitest';

import {
  auditFailureNotification,
  completionHarness,
  insertFailureNotificationDeliveryOutbox,
  intentId,
  workspaceId,
} from './fixture.js';

export function registerRejectsPreAbortedCompletionBefore(): void {
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
}
