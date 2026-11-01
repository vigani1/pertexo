import { expect, it } from 'vitest';

import {
  auditFailureNotification,
  completionHarness,
  insertFailureNotificationDeliveryOutbox,
  intentId,
  workspaceId,
} from './fixture.js';

export function registerInvalidCompletionInputs(): void {
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
}
