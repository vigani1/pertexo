import { describe, expect, it, vi } from 'vitest';

import type { FailureNotificationStore } from '@pertexo/database';
import {
  ConnectionSecretEncryptionError,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  type ResendClient,
  type SlackClient,
} from '@pertexo/integrations/server';

import { createProviderFailureNotificationDelivery } from '../src/execution/failure-notification-delivery.js';

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
const identity = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  intentId: '55555555-5555-4555-8555-555555555555',
  attemptNumber: 1,
  destinationId: '66666666-6666-4666-8666-666666666666',
  destinationConfigVersion: 2,
  connectionSecretVersionId: '77777777-7777-4777-8777-777777777777',
  idempotencyKey:
    'failure-notification:v1:55555555-5555-4555-8555-555555555555',
  deliveryUnresolved: false,
  context,
  signal: new AbortController().signal,
};
const sealed = {
  schemaVersion: 1 as const,
  kmsKeyReference: 'kms',
  encryptedDataKey: 'key',
  ciphertext: 'cipher',
  nonce: 'nonce',
  tag: 'tag',
};

function store(kind: 'slack' | 'email'): FailureNotificationStore {
  return {
    claimDelivery: vi.fn(),
    completeDelivery: vi.fn(),
    recoverDue: vi.fn(),
    close: vi.fn(),
    loadDestination: vi.fn().mockResolvedValue({
      kind,
      connectionId: '88888888-8888-4888-8888-888888888888',
      secretVersionId: identity.connectionSecretVersionId,
      sealed,
      ...(kind === 'slack'
        ? { channelId: 'C12345' }
        : { toEmail: 'ops@example.test' }),
    }),
    fenceDispatch: vi.fn(),
  };
}

describe('provider failure notification delivery', () => {
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
        new (await import('@pertexo/database')).FailureNotificationStateError(
          'destination disabled',
        ),
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

  it.each(['slack', 'email'] as const)(
    'classifies malformed %s credentials before provider bytes',
    async (kind) => {
      const persistence = store(kind);
      const sendMessage = vi.fn();
      const sendNotification = vi.fn();
      const delivery = createProviderFailureNotificationDelivery({
        store: persistence,
        encryption: {
          open: vi
            .fn()
            .mockResolvedValue(new TextEncoder().encode('{"schemaVersion":1}')),
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
          true,
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
                        schemaVersion: 1,
                        type: 'slack_bot_token',
                        botToken: 'xoxb-1234567890',
                      }
                    : {
                        schemaVersion: 1,
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
              schemaVersion: 1,
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

    await expect(
      delivery.deliver({ ...identity, sideEffectClass: 'unsafe' }),
    ).resolves.toMatchObject({ kind: 'delivered', providerReference: '1.2' });
    expect(vi.mocked(persistence.fenceDispatch)).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0].text).toContain('provider.failure');
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
                schemaVersion: 1,
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
          /^email:v1:sha256:[0-9a-f]{64}$/u,
        ),
      }),
    );
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: identity.idempotencyKey }),
    );
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
      const delivery = createProviderFailureNotificationDelivery({
        store: persistence,
        encryption: {
          open: vi.fn().mockResolvedValue(
            new TextEncoder().encode(
              JSON.stringify({
                schemaVersion: 1,
                type: 'resend_api_key',
                apiKey: 're_12345678',
                fromEmail: 'sender@example.test',
              }),
            ),
          ),
        },
        slack: { sendMessage: vi.fn() },
        email: { sendNotification: vi.fn().mockResolvedValue(providerResult) },
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
                schemaVersion: 1,
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
                schemaVersion: 1,
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
        new (await import('@pertexo/database')).FailureNotificationStateError(
          'fence rejected',
        ),
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
                        schemaVersion: 1,
                        type: 'slack_bot_token',
                        botToken: 'xoxb-1234567890',
                      }
                    : {
                        schemaVersion: 1,
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
      new (await import('@pertexo/database')).FailureNotificationStateError(
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
                schemaVersion: 1,
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
        deliveryBinding: `email:v1:sha256:${'a'.repeat(64)}`,
      }),
    ).resolves.toMatchObject({
      kind: 'definite_failure',
      possiblyDispatched: false,
    });
    await expect(
      delivery.deliver({
        ...identity,
        sideEffectClass: 'idempotent_with_key',
        deliveryBinding: `email:v1:sha256:${'a'.repeat(64)}`,
        deliveryUnresolved: true,
      }),
    ).resolves.toMatchObject({
      kind: 'outcome_unknown',
      possiblyDispatched: true,
    });
  });
});
