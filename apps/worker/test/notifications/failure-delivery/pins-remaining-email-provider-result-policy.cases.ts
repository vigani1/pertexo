import { expect, it, vi } from 'vitest';

import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
} from '@pertexo/integrations/server';
import { createProviderFailureNotificationDelivery } from '../../../src/notifications/failure-delivery.js';
import { identity, sealed, store } from './fixture.js';

export function registerPinsRemainingEmailProviderResultPolicy(): void {
  it.each([
    [{ kind: 'succeeded' as const, emailId: 'email-1' }, 'delivered'],
    [
      { kind: 'rejected' as const, error: 'concurrent_idempotent_requests' },
      'retry',
    ],
    [
      { kind: 'rejected' as const, error: 'invalid_from_address' },
      'definite_failure',
    ],
    [{ kind: 'http_failure' as const, status: 400 }, 'definite_failure'],
    [{ kind: 'invalid_response' as const }, 'retry'],
  ] as const)(
    'pins remaining email provider result policy',
    async (result, kind) => {
      const delivery = createProviderFailureNotificationDelivery({
        store: store('email'),
        encryption: {
          open: vi.fn().mockResolvedValue(
            new TextEncoder().encode(
              JSON.stringify({
                type: 'resend_api_key',
                apiKey: 're_12345678',
                fromEmail: 'sender@example.test',
              }),
            ),
          ),
        },
        slack: { sendMessage: vi.fn() },
        email: { sendNotification: vi.fn().mockResolvedValue(result) },
        workerId: 'worker-1',
      });

      await expect(
        delivery.deliver({
          ...identity,
          sideEffectClass: 'idempotent_with_key',
        }),
      ).resolves.toMatchObject({ kind });
    },
  );

  it.each([
    [SECURE_HTTP_ERROR_CODE.timedOut, 'retry', 'delivery.provider_unavailable'],
    [
      SECURE_HTTP_ERROR_CODE.responseTooLarge,
      'definite_failure',
      'delivery.provider_rejected',
    ],
  ] as const)(
    'pins predispatch secure HTTP failure policy for %s',
    async (code, kind, safeErrorCode) => {
      const delivery = createProviderFailureNotificationDelivery({
        store: store('slack'),
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
        slack: {
          sendMessage: vi.fn().mockRejectedValue(
            new SecureHttpError(code, 'definite_failure', {
              possiblyDispatched: false,
            }),
          ),
        },
        email: { sendNotification: vi.fn() },
        workerId: 'worker-1',
      });

      await expect(
        delivery.deliver({ ...identity, sideEffectClass: 'unsafe' }),
      ).resolves.toMatchObject({ kind, safeErrorCode });
    },
  );

  it('fails closed on cancellation before destination loading settles', async () => {
    const controller = new AbortController();
    controller.abort();
    const persistence = store('slack');
    vi.mocked(persistence.loadDestination).mockRejectedValue(
      new AggregateError([], 'database unavailable'),
    );
    const delivery = createProviderFailureNotificationDelivery({
      store: persistence,
      encryption: { open: vi.fn() },
      slack: { sendMessage: vi.fn() },
      email: { sendNotification: vi.fn() },
      workerId: 'worker-1',
    });

    await expect(
      delivery.deliver({
        ...identity,
        sideEffectClass: 'unsafe',
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      kind: 'retry',
      safeErrorCode: 'delivery.canceled',
    });
  });

  it('keeps a retry of a possibly sent alert on the credential that send used', async () => {
    const persistence = store('email');
    vi.mocked(persistence.loadDestination).mockResolvedValue({
      kind: 'email',
      connectionId: '88888888-8888-4888-8888-888888888888',
      secretVersionId: '99999999-9999-4999-8999-999999999999',
      sealed,
      toEmail: 'ops@example.test',
    });
    const delivery = createProviderFailureNotificationDelivery({
      store: persistence,
      encryption: { open: vi.fn() },
      slack: { sendMessage: vi.fn() },
      email: { sendNotification: vi.fn() },
      workerId: 'worker-1',
    });

    await expect(
      delivery.deliver({
        ...identity,
        sideEffectClass: 'idempotent_with_key',
        deliveryUnresolved: true,
      }),
    ).resolves.toMatchObject({
      kind: 'outcome_unknown',
      safeErrorCode: 'delivery.previous_outcome_unresolved',
    });
  });
}
