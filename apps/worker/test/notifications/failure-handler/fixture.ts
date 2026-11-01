import { failureContext } from '../../support/notification-context.js';
import { vi } from 'vitest';
import type { FailureNotificationStore } from '@pertexo/core/testing';

export const context = failureContext();

export const delivery = {
  name: 'deliver-run-failure-notification' as const,
  data: {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    notificationIntentId: '55555555-5555-4555-8555-555555555555',
    outboxEventId: '66666666-6666-4666-8666-666666666666',
  },
  transport: {
    attemptsMade: 0,
    jobId: 'outbox-66666666-6666-4666-8666-666666666666',
  },
};

export function readyClaim() {
  return {
    kind: 'ready' as const,
    attemptNumber: 1,
    context,
    destinationId: '77777777-7777-4777-8777-777777777777',
    destinationConfigVersion: 2,
    idempotencyKey: 'failure-notification:55555555-5555-4555-8555-555555555555',
    sideEffectClass: 'idempotent_with_key' as const,
    connectionSecretVersionId: '88888888-8888-4888-8888-888888888888',
    deliveryUnresolved: false,
  };
}

export function store(kind: 'ready' | 'terminal' = 'ready') {
  return {
    claimDelivery: vi
      .fn<FailureNotificationStore['claimDelivery']>()
      .mockResolvedValue(kind === 'terminal' ? { kind } : readyClaim()),
    completeDelivery: vi
      .fn<NonNullable<FailureNotificationStore['completeDelivery']>>()
      .mockResolvedValue('completed'),
    loadDestination:
      vi.fn<NonNullable<FailureNotificationStore['loadDestination']>>(),
    fenceDispatch:
      vi.fn<NonNullable<FailureNotificationStore['fenceDispatch']>>(),
    recoverDue: vi.fn<NonNullable<FailureNotificationStore['recoverDue']>>(),
    close: vi.fn<NonNullable<FailureNotificationStore['close']>>(),
  } satisfies FailureNotificationStore;
}

export function readyDeliveryResult() {
  return {
    kind: 'delivered' as const,
    possiblyDispatched: true as const,
    providerReference: 'late-provider-reference',
  };
}
