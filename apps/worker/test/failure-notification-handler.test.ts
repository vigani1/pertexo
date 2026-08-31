import { describe, expect, it, vi } from 'vitest';

import type { FailureNotificationStore } from '@pertexo/database/testing';

import { createFailureNotificationHandler } from '../src/execution/failure-notification-handler.js';

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method -- Vitest asymmetric matchers and injected spies */

const context = {
  schemaVersion: 1 as const,
  runId: '22222222-2222-4222-8222-222222222222',
  workflowId: '33333333-3333-4333-8333-333333333333',
  workflowVersionId: '44444444-4444-4444-8444-444444444444',
  terminalEventSequence: 7,
  terminalStatus: 'failed' as const,
  triggerType: 'manual' as const,
  startedAt: '2026-08-24T10:00:00.000Z',
  completedAt: '2026-08-24T10:01:00.000Z',
  primaryFailure: {
    nodeId: 'send',
    invocationKey: 'send',
    nodeStatus: 'failed' as const,
    attemptNumber: 1,
    safeErrorCode: 'provider.failure',
  },
  totalFailureCount: 1,
};

const delivery = {
  name: 'deliver-run-failure-notification' as const,
  data: {
    schemaVersion: 1 as const,
    workspaceId: '11111111-1111-4111-8111-111111111111',
    notificationIntentId: '55555555-5555-4555-8555-555555555555',
    outboxEventId: '66666666-6666-4666-8666-666666666666',
  },
  transport: {
    attemptsMade: 0,
    jobId: 'outbox-66666666-6666-4666-8666-666666666666',
  },
};

function store(kind: 'ready' | 'terminal' = 'ready'): FailureNotificationStore {
  return {
    claimDelivery: vi.fn().mockResolvedValue(
      kind === 'terminal'
        ? { kind }
        : {
            kind,
            attemptNumber: 1,
            context,
            destinationId: '77777777-7777-4777-8777-777777777777',
            destinationConfigVersion: 2,
            idempotencyKey:
              'failure-notification:v1:55555555-5555-4555-8555-555555555555',
            sideEffectClass: 'idempotent_with_key',
            connectionSecretVersionId: '88888888-8888-4888-8888-888888888888',
            deliveryUnresolved: false,
          },
    ),
    completeDelivery: vi.fn().mockResolvedValue('completed'),
    loadDestination: vi.fn(),
    fenceDispatch: vi.fn(),
    recoverDue: vi.fn(),
    close: vi.fn(),
  };
}

describe('failure notification handler', () => {
  it('delivers loaded immutable context and persists a bounded result', async () => {
    const repository = store();
    const deliver = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      kind: 'delivered',
      possiblyDispatched: true,
      providerReference: 'opaque-ref',
    });
    const handler = createFailureNotificationHandler({
      store: repository,
      delivery: { deliver },
      timeoutMillis: 100,
      maxAttempts: 3,
      retryDelaySeconds: 1,
    });

    await handler.handle(delivery, { signal: new AbortController().signal });

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ context, destinationConfigVersion: 2 }),
    );
    expect(repository.completeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ kind: 'delivered' }),
      }),
    );
  });

  it('makes duplicate terminal delivery inert', async () => {
    const repository = store('terminal');
    const deliver = vi.fn();
    const handler = createFailureNotificationHandler({
      store: repository,
      delivery: { deliver },
      timeoutMillis: 100,
      maxAttempts: 3,
      retryDelaySeconds: 1,
    });
    await handler.handle(delivery, { signal: new AbortController().signal });
    expect(deliver).not.toHaveBeenCalled();
    expect(repository.completeDelivery).not.toHaveBeenCalled();
  });

  it('records provider timeout as retry with unresolved dispatch evidence', async () => {
    const repository = store();
    const handler = createFailureNotificationHandler({
      store: repository,
      delivery: {
        deliver: ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                reject(new Error('aborted'));
              },
              { once: true },
            );
          }),
      },
      timeoutMillis: 5,
      maxAttempts: 3,
      retryDelaySeconds: 1,
    });
    await handler.handle(delivery, { signal: new AbortController().signal });
    expect(repository.completeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        result: {
          schemaVersion: 1,
          kind: 'retry',
          safeErrorCode: 'delivery.timeout',
          possiblyDispatched: true,
        },
      }),
    );
  });
});
