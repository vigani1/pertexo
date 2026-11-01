import { expect, it, vi } from 'vitest';

import type { ResendClient, SlackClient } from '@pertexo/integrations/server';
import { createProviderFailureNotificationDelivery } from '../../../src/notifications/failure-delivery.js';
import { identity, store } from './fixture.js';

export function registerClassifiesSlackSWithoutUnsafeAmbiguous(): void {
  it.each([
    [
      'HTTP 5xx',
      { kind: 'http_failure' as const, status: 503 },
      { kind: 'outcome_unknown', possiblyDispatched: true },
    ],
    [
      'invalid response',
      { kind: 'invalid_response' as const },
      { kind: 'outcome_unknown', possiblyDispatched: true },
    ],
    [
      'explicit service unavailable',
      { kind: 'rejected' as const, error: 'service_unavailable' },
      { kind: 'retry', possiblyDispatched: false },
    ],
    [
      'rate limit',
      { kind: 'rate_limited' as const, retryAfterMillis: 1_000 },
      { kind: 'retry', possiblyDispatched: false },
    ],
    [
      'invalid authentication',
      { kind: 'rejected' as const, error: 'invalid_auth' },
      { kind: 'definite_failure', possiblyDispatched: false },
    ],
  ])(
    'classifies Slack %s without unsafe ambiguous retry',
    async (_name, providerResult, expected) => {
      const persistence = store('slack');
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
        slack: { sendMessage: vi.fn().mockResolvedValue(providerResult) },
        email: { sendNotification: vi.fn() },
        workerId: 'worker-1',
      });

      await expect(
        delivery.deliver({ ...identity, sideEffectClass: 'unsafe' }),
      ).resolves.toMatchObject(expected);
    },
  );

  it.each(['slack', 'email'] as const)(
    'blocks %s provider bytes when destination disable wins the final fence',
    async (kind) => {
      const persistence = store(kind);
      const providerCalls: string[] = [];
      vi.mocked(persistence.fenceDispatch).mockRejectedValue(
        new (
          await import('@pertexo/core/testing')
        ).FailureNotificationStateError('fence rejected'),
      );
      const delivery = createProviderFailureNotificationDelivery({
        store: persistence,
        encryption: {
          open: vi.fn(() =>
            Promise.resolve(
              new TextEncoder().encode(
                JSON.stringify(
                  kind === 'slack'
                    ? {
                        type: 'slack_bot_token',
                        botToken: 'xoxb-1234567890',
                      }
                    : {
                        type: 'resend_api_key',
                        apiKey: 're_12345678',
                        fromEmail: 'sender@example.test',
                      },
                ),
              ),
            ),
          ),
        },
        slack: {
          sendMessage: vi.fn<SlackClient['sendMessage']>(async (input) => {
            await input.beforeDispatch();
            providerCalls.push('slack');
            throw new Error('provider bytes must not be sent');
          }),
        },
        email: {
          sendNotification: vi.fn<ResendClient['sendNotification']>(
            async (input) => {
              await input.beforeDispatch();
              providerCalls.push('email');
              throw new Error('provider bytes must not be sent');
            },
          ),
        },
        workerId: 'worker-1',
      });

      await expect(
        delivery.deliver({
          ...identity,
          sideEffectClass: kind === 'slack' ? 'unsafe' : 'idempotent_with_key',
        }),
      ).resolves.toMatchObject({
        kind: 'definite_failure',
        safeErrorCode: 'delivery.dispatch_fence_failed',
        possiblyDispatched: false,
      });
      expect(providerCalls).toEqual([]);
      expect(persistence.completeDelivery).not.toHaveBeenCalled();
    },
  );

  it('uses persisted unresolved dispatch truth rather than binding presence', async () => {
    const persistence = store('email');
    vi.mocked(persistence.fenceDispatch).mockRejectedValue(
      new (await import('@pertexo/core/testing')).FailureNotificationStateError(
        'fence rejected',
      ),
    );
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
        sendNotification: vi.fn<ResendClient['sendNotification']>(
          async (input) => {
            await input.beforeDispatch();
            return { kind: 'succeeded' as const, emailId: crypto.randomUUID() };
          },
        ),
      },
      workerId: 'worker-1',
    });

    await expect(
      delivery.deliver({
        ...identity,
        sideEffectClass: 'idempotent_with_key',
      }),
    ).resolves.toMatchObject({
      kind: 'definite_failure',
      possiblyDispatched: false,
    });
    await expect(
      delivery.deliver({
        ...identity,
        sideEffectClass: 'idempotent_with_key',
        deliveryBinding: `email:sha256:${'a'.repeat(64)}`,
      }),
    ).resolves.toMatchObject({
      kind: 'definite_failure',
      possiblyDispatched: false,
    });
    await expect(
      delivery.deliver({
        ...identity,
        sideEffectClass: 'idempotent_with_key',
        deliveryBinding: `email:sha256:${'a'.repeat(64)}`,
        deliveryUnresolved: true,
      }),
    ).resolves.toMatchObject({
      kind: 'outcome_unknown',
      possiblyDispatched: true,
    });
  });

  it.each([
    [
      { kind: 'rejected' as const, error: 'unexpected_provider_code' },
      'outcome_unknown',
    ],
    [{ kind: 'http_failure' as const, status: 400 }, 'definite_failure'],
  ] as const)(
    'pins remaining Slack provider result policy',
    async (result, kind) => {
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
        slack: { sendMessage: vi.fn().mockResolvedValue(result) },
        email: { sendNotification: vi.fn() },
        workerId: 'worker-1',
      });

      await expect(
        delivery.deliver({ ...identity, sideEffectClass: 'unsafe' }),
      ).resolves.toMatchObject({ kind });
    },
  );
}
