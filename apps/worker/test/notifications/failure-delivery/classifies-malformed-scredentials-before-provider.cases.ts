import { expect, it, vi } from 'vitest';

import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  type ResendClient,
} from '@pertexo/integrations/server';
import { createProviderFailureNotificationDelivery } from '../../../src/notifications/failure-delivery.js';
import {
  context,
  identity,
  store,
  successfulSlackDelivery,
} from './fixture.js';

export function registerClassifiesMalformedSCredentialsBeforeProvider(): void {
  it.each(['slack', 'email'] as const)(
    'classifies malformed %s credentials before provider bytes',
    async (kind) => {
      const persistence = store(kind);
      const sendMessage = vi.fn();
      const sendNotification = vi.fn();
      const delivery = createProviderFailureNotificationDelivery({
        store: persistence,
        encryption: {
          open: vi.fn().mockResolvedValue(new TextEncoder().encode('{}')),
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
        kind: 'definite_failure',
        safeErrorCode: 'delivery.credential_invalid',
        possiblyDispatched: false,
      });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(sendNotification).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['slack', 'outcome_unknown'],
    ['email', 'retry'],
  ] as const)(
    'classifies post-fence %s transport ambiguity without throwing',
    async (kind, expectedKind) => {
      const persistence = store(kind);
      const ambiguous = async (input: { beforeDispatch(): Promise<void> }) => {
        await input.beforeDispatch();
        throw new SecureHttpError(
          SECURE_HTTP_ERROR_CODE.networkFailed,
          'ambiguous',
          { possiblyDispatched: true },
        );
      };
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
        slack: { sendMessage: ambiguous },
        email: { sendNotification: ambiguous },
        workerId: 'worker-1',
      });

      await expect(
        delivery.deliver({
          ...identity,
          sideEffectClass: kind === 'slack' ? 'unsafe' : 'idempotent_with_key',
        }),
      ).resolves.toMatchObject({
        kind: expectedKind,
        possiblyDispatched: true,
      });
    },
  );

  it('sends deterministic Slack text only after the durable fence', async () => {
    const persistence = store('slack');
    const { delivery, sendMessage } = successfulSlackDelivery(persistence);

    await expect(
      delivery.deliver({ ...identity, sideEffectClass: 'unsafe' }),
    ).resolves.toMatchObject({ kind: 'delivered', providerReference: '1.2' });
    expect(vi.mocked(persistence.fenceDispatch)).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0].text).toContain('provider.failure');
  });

  it('renders a run-level timeout without inventing a node', async () => {
    const persistence = store('slack');
    const { delivery, sendMessage } = successfulSlackDelivery(persistence);

    await expect(
      delivery.deliver({
        ...identity,
        sideEffectClass: 'unsafe',
        context: {
          ...context,
          terminalStatus: 'timed_out',
          primaryFailure: {
            source: 'run',
            runStatus: 'timed_out',
            safeErrorCode: 'execution.deadline_exceeded',
          },
        },
      }),
    ).resolves.toMatchObject({ kind: 'delivered' });
    expect(sendMessage.mock.calls[0]?.[0].text).toContain(
      'Failure: execution.deadline_exceeded',
    );
    expect(sendMessage.mock.calls[0]?.[0].text).toContain(
      'Scope: run (timed_out)',
    );
    expect(sendMessage.mock.calls[0]?.[0].text).not.toContain('Node:');
  });

  it('binds identical Resend identity and payload before retryable delivery', async () => {
    const persistence = store('email');
    const sendNotification = vi.fn<ResendClient['sendNotification']>(
      async (input) => {
        await input.beforeDispatch();
        return { kind: 'rate_limited' as const, retryAfterMillis: 1_000 };
      },
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
      email: { sendNotification },
      workerId: 'worker-1',
    });

    await expect(
      delivery.deliver({
        ...identity,
        sideEffectClass: 'idempotent_with_key',
      }),
    ).resolves.toMatchObject({ kind: 'retry', possiblyDispatched: false });
    expect(vi.mocked(persistence.fenceDispatch)).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryBinding: expect.stringMatching(
          /^email:sha256:[0-9a-f]{64}$/u,
        ) as unknown,
        signal: identity.signal,
      }),
    );
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: identity.idempotencyKey }),
    );
  });
}
