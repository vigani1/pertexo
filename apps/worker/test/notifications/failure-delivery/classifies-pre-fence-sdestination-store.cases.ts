import { expect, it, vi } from 'vitest';

import { ConnectionSecretEncryptionError } from '@pertexo/integrations/server';
import { createProviderFailureNotificationDelivery } from '../../../src/notifications/failure-delivery.js';
import type { sealed } from './fixture.js';
import { identity, store } from './fixture.js';

export function registerClassifiesPreFenceSDestinationStore(): void {
  it.each(['slack', 'email'] as const)(
    'classifies pre-fence %s destination-store loss without provider bytes',
    async (kind) => {
      const persistence = store(kind);
      vi.mocked(persistence.loadDestination).mockRejectedValue(
        new AggregateError([], 'database unavailable'),
      );
      const sendMessage = vi.fn();
      const sendNotification = vi.fn();
      const delivery = createProviderFailureNotificationDelivery({
        store: persistence,
        encryption: { open: vi.fn() },
        slack: { sendMessage },
        email: { sendNotification },
        workerId: 'worker-1',
      });

      await expect(
        delivery.deliver({
          ...identity,
          sideEffectClass: kind === 'slack' ? 'unsafe' : 'idempotent_with_key',
        }),
      ).resolves.toMatchObject({
        kind: 'retry',
        safeErrorCode: 'delivery.destination_unavailable',
        possiblyDispatched: false,
      });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(sendNotification).not.toHaveBeenCalled();
    },
  );

  it('preserves unresolved Slack truth when credential bytes are invalid UTF-8', async () => {
    const persistence = store('slack');
    const sendMessage = vi.fn();
    const delivery = createProviderFailureNotificationDelivery({
      store: persistence,
      encryption: { open: vi.fn().mockResolvedValue(Uint8Array.from([0xff])) },
      slack: { sendMessage },
      email: { sendNotification: vi.fn() },
      workerId: 'worker-1',
    });

    await expect(
      delivery.deliver({
        ...identity,
        sideEffectClass: 'unsafe',
        deliveryUnresolved: true,
      }),
    ).resolves.toMatchObject({
      kind: 'outcome_unknown',
      safeErrorCode: 'delivery.previous_outcome_unresolved',
      possiblyDispatched: true,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(['slack', 'email'] as const)(
    'terminalizes disabled %s destination loading without provider bytes',
    async (kind) => {
      const persistence = store(kind);
      vi.mocked(persistence.loadDestination).mockRejectedValue(
        new (
          await import('@pertexo/core/testing')
        ).FailureNotificationStateError('destination disabled'),
      );
      const sendMessage = vi.fn();
      const sendNotification = vi.fn();
      const delivery = createProviderFailureNotificationDelivery({
        store: persistence,
        encryption: { open: vi.fn() },
        slack: { sendMessage },
        email: { sendNotification },
        workerId: 'worker-1',
      });

      await expect(
        delivery.deliver({
          ...identity,
          sideEffectClass: kind === 'slack' ? 'unsafe' : 'idempotent_with_key',
        }),
      ).resolves.toMatchObject({
        kind: 'definite_failure',
        safeErrorCode: 'delivery.destination_unavailable',
        possiblyDispatched: false,
      });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(sendNotification).not.toHaveBeenCalled();
    },
  );

  it('preserves unresolved truth when destination identity can no longer load', async () => {
    const persistence = store('email');
    vi.mocked(persistence.loadDestination).mockRejectedValue(
      new (await import('@pertexo/core/testing')).FailureNotificationStateError(
        'destination changed',
      ),
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
        sideEffectClass: 'idempotent_with_key',
        deliveryUnresolved: true,
      }),
    ).resolves.toMatchObject({
      kind: 'outcome_unknown',
      safeErrorCode: 'delivery.identity_changed',
      possiblyDispatched: true,
    });
  });

  it.each(['slack', 'email'] as const)(
    'bounds blocked %s credential loading on shutdown without provider bytes',
    async (kind) => {
      const persistence = store(kind);
      const controller = new AbortController();
      const sendMessage = vi.fn();
      const sendNotification = vi.fn();
      const delivery = createProviderFailureNotificationDelivery({
        store: persistence,
        encryption: {
          open: vi.fn(
            (
              _sealed: typeof sealed,
              _context: Readonly<{
                workspaceId: string;
                connectionId: string;
                secretVersionId: string;
              }>,
              signal?: AbortSignal,
            ) =>
              new Promise<Uint8Array>((_resolve, reject) => {
                if (signal?.aborted === true) {
                  reject(new ConnectionSecretEncryptionError());
                  return;
                }
                signal?.addEventListener(
                  'abort',
                  () => {
                    reject(new ConnectionSecretEncryptionError());
                  },
                  { once: true },
                );
              }),
          ),
        },
        slack: { sendMessage },
        email: { sendNotification },
        workerId: 'worker-1',
      });
      const pending = delivery.deliver({
        ...identity,
        sideEffectClass: kind === 'slack' ? 'unsafe' : 'idempotent_with_key',
        signal: controller.signal,
      });

      controller.abort();

      await expect(pending).resolves.toMatchObject({
        kind: 'retry',
        possiblyDispatched: false,
      });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(sendNotification).not.toHaveBeenCalled();
    },
  );

  it.each(['slack', 'email'] as const)(
    'classifies %s KMS failure as predispatch retry without provider bytes',
    async (kind) => {
      const persistence = store(kind);
      const sendMessage = vi.fn();
      const sendNotification = vi.fn();
      const delivery = createProviderFailureNotificationDelivery({
        store: persistence,
        encryption: {
          open: vi
            .fn()
            .mockRejectedValue(new ConnectionSecretEncryptionError()),
        },
        slack: { sendMessage },
        email: { sendNotification },
        workerId: 'worker-1',
      });

      await expect(
        delivery.deliver({
          ...identity,
          sideEffectClass: kind === 'slack' ? 'unsafe' : 'idempotent_with_key',
        }),
      ).resolves.toMatchObject({
        kind: 'retry',
        safeErrorCode: 'delivery.credential_unavailable',
        possiblyDispatched: false,
      });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(sendNotification).not.toHaveBeenCalled();
    },
  );
}
