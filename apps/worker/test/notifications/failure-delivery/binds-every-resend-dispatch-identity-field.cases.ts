import { expect, it, vi } from 'vitest';

import type { ResendClient } from '@pertexo/integrations/server';
import { createProviderFailureNotificationDelivery } from '../../../src/notifications/failure-delivery.js';
import { context, identity, sealed, store } from './fixture.js';

export function registerBindsEveryResendDispatchIdentityField(): void {
  it('binds every Resend dispatch identity field deterministically', async () => {
    const bindingFor = async (
      overrides: {
        secretVersionId?: string;
        fromEmail?: string;
        toEmail?: string;
        idempotencyKey?: string;
        context?: typeof context;
      } = {},
    ): Promise<string> => {
      const persistence = store('email');
      const secretVersionId =
        overrides.secretVersionId ?? identity.connectionSecretVersionId;
      vi.mocked(persistence.loadDestination).mockResolvedValue({
        kind: 'email',
        connectionId: '88888888-8888-4888-8888-888888888888',
        secretVersionId,
        sealed,
        toEmail: overrides.toEmail ?? 'ops@example.test',
      });
      const delivery = createProviderFailureNotificationDelivery({
        store: persistence,
        encryption: {
          open: vi.fn(() =>
            Promise.resolve(
              new TextEncoder().encode(
                JSON.stringify({
                  type: 'resend_api_key',
                  apiKey: 're_12345678',
                  fromEmail: overrides.fromEmail ?? 'sender@example.test',
                }),
              ),
            ),
          ),
        },
        slack: { sendMessage: vi.fn() },
        email: {
          sendNotification: vi.fn<ResendClient['sendNotification']>(
            async (input) => {
              await input.beforeDispatch();
              return { kind: 'succeeded', emailId: 'email-1' };
            },
          ),
        },
        workerId: 'worker-1',
      });
      await delivery.deliver({
        ...identity,
        connectionSecretVersionId: secretVersionId,
        idempotencyKey: overrides.idempotencyKey ?? identity.idempotencyKey,
        context: overrides.context ?? context,
        sideEffectClass: 'idempotent_with_key',
      });
      const binding = vi.mocked(persistence.fenceDispatch).mock.calls[0]?.[0]
        .deliveryBinding;
      if (binding === undefined)
        throw new Error('email binding was not fenced');
      return binding;
    };

    const baseline = await bindingFor();
    await expect(bindingFor()).resolves.toBe(baseline);
    expect(baseline).toMatch(/^email:sha256:[0-9a-f]{64}$/u);
    const variants = [
      await bindingFor({
        secretVersionId: '99999999-9999-4999-8999-999999999999',
      }),
      await bindingFor({ fromEmail: 'other-sender@example.test' }),
      await bindingFor({ toEmail: 'other-ops@example.test' }),
      await bindingFor({ idempotencyKey: `${identity.idempotencyKey}:other` }),
      await bindingFor({
        context: { ...context, workflowId: crypto.randomUUID() },
      }),
    ];
    expect(new Set(variants).size).toBe(variants.length);
    for (const binding of variants) expect(binding).not.toBe(baseline);
  });

  it.each([
    [
      'post-dispatch HTTP 5xx',
      { kind: 'http_failure' as const, status: 503 },
      { kind: 'retry', possiblyDispatched: true },
      { kind: 'outcome_unknown', possiblyDispatched: true },
    ],
    [
      'definite rate limit',
      { kind: 'rate_limited' as const, retryAfterMillis: 1_000 },
      { kind: 'retry', possiblyDispatched: false },
      { kind: 'outcome_unknown', possiblyDispatched: true },
    ],
  ])(
    'settles email %s from persisted ambiguity',
    async (_name, providerResult, initial, unresolved) => {
      const persistence = store('email');
      const credentialBytes: Uint8Array[] = [];
      const sendNotification = vi.fn().mockResolvedValue(providerResult);
      const delivery = createProviderFailureNotificationDelivery({
        store: persistence,
        encryption: {
          open: vi.fn(() => {
            const bytes = new TextEncoder().encode(
              JSON.stringify({
                type: 'resend_api_key',
                apiKey: 're_12345678',
                fromEmail: 'sender@example.test',
              }),
            );
            credentialBytes.push(bytes);
            return Promise.resolve(bytes);
          }),
        },
        slack: { sendMessage: vi.fn() },
        email: { sendNotification },
        workerId: 'worker-1',
      });

      await expect(
        delivery.deliver({
          ...identity,
          sideEffectClass: 'idempotent_with_key',
        }),
      ).resolves.toMatchObject(initial);
      await expect(
        delivery.deliver({
          ...identity,
          attemptNumber: 2,
          deliveryUnresolved: true,
          sideEffectClass: 'idempotent_with_key',
        }),
      ).resolves.toMatchObject(unresolved);
      expect(sendNotification).toHaveBeenCalledTimes(2);
      expect(credentialBytes).toHaveLength(2);
      for (const bytes of credentialBytes)
        expect([...bytes].every((byte) => byte === 0)).toBe(true);
    },
  );

  it('keeps repeated definite email rate limits retryable', async () => {
    const persistence = store('email');
    const delivery = createProviderFailureNotificationDelivery({
      store: persistence,
      encryption: {
        open: vi.fn(() =>
          Promise.resolve(
            new TextEncoder().encode(
              JSON.stringify({
                type: 'resend_api_key',
                apiKey: 're_12345678',
                fromEmail: 'sender@example.test',
              }),
            ),
          ),
        ),
      },
      slack: { sendMessage: vi.fn() },
      email: {
        sendNotification: vi.fn().mockResolvedValue({
          kind: 'rate_limited',
          retryAfterMillis: 1_000,
        }),
      },
      workerId: 'worker-1',
    });

    for (const attemptNumber of [1, 2])
      await expect(
        delivery.deliver({
          ...identity,
          attemptNumber,
          sideEffectClass: 'idempotent_with_key',
        }),
      ).resolves.toMatchObject({ kind: 'retry', possiblyDispatched: false });
  });
}
