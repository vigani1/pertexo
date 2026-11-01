import { failureContext } from '../../support/notification-context.js';
import { vi } from 'vitest';
import type { FailureNotificationStore } from '@pertexo/core/testing';
import type { SlackClient } from '@pertexo/integrations/server';
import { createProviderFailureNotificationDelivery } from '../../../src/notifications/failure-delivery.js';

export const context = failureContext();

export const identity = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  intentId: '55555555-5555-4555-8555-555555555555',
  attemptNumber: 1,
  destinationId: '66666666-6666-4666-8666-666666666666',
  destinationConfigVersion: 2,
  connectionSecretVersionId: '77777777-7777-4777-8777-777777777777',
  idempotencyKey: 'failure-notification:55555555-5555-4555-8555-555555555555',
  deliveryUnresolved: false,
  context,
  signal: new AbortController().signal,
};

export const sealed = {
  kmsKeyReference: 'kms',
  encryptedDataKey: 'key',
  ciphertext: 'cipher',
  nonce: 'nonce',
  tag: 'tag',
};

export function store(kind: 'slack' | 'email') {
  return {
    claimDelivery:
      vi.fn<NonNullable<FailureNotificationStore['claimDelivery']>>(),
    completeDelivery:
      vi.fn<NonNullable<FailureNotificationStore['completeDelivery']>>(),
    recoverDue: vi.fn<NonNullable<FailureNotificationStore['recoverDue']>>(),
    close: vi.fn<NonNullable<FailureNotificationStore['close']>>(),
    loadDestination: vi.fn().mockResolvedValue({
      kind,
      connectionId: '88888888-8888-4888-8888-888888888888',
      secretVersionId: identity.connectionSecretVersionId,
      sealed,
      ...(kind === 'slack'
        ? { channelId: 'C12345' }
        : { toEmail: 'ops@example.test' }),
    }),
    fenceDispatch:
      vi.fn<NonNullable<FailureNotificationStore['fenceDispatch']>>(),
  } satisfies FailureNotificationStore;
}

export function successfulSlackDelivery(persistence: FailureNotificationStore) {
  const sendMessage = vi.fn<SlackClient['sendMessage']>(async (input) => {
    await input.beforeDispatch();
    return {
      kind: 'succeeded' as const,
      channelId: 'C12345',
      messageTs: '1.2',
    };
  });
  const delivery = createProviderFailureNotificationDelivery({
    store: persistence,
    encryption: {
      open: vi.fn().mockResolvedValue(
        new TextEncoder().encode(
          JSON.stringify({
            type: 'slack_bot_token',
            botToken: 'xoxb-1234567890',
          }),
        ),
      ),
    },
    slack: { sendMessage },
    email: { sendNotification: vi.fn() },
    workerId: 'worker-1',
  });
  return { delivery, sendMessage };
}
