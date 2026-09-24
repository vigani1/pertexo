import type { AuthenticationMailDeliveryStore } from '@pertexo/database/execution';
import {
  createApplicationSecretEnvelope,
  createResendClient,
} from '@pertexo/integrations/server';
import { describe, expect, it, vi } from 'vitest';

import { createAuthenticationMailDeliveryHandler } from '../src/execution/authentication-mail-delivery.js';

const claim = {
  id: '11111111-1111-4111-8111-111111111111',
  purpose: 'password_reset' as const,
  expiresAt: new Date('2026-09-23T01:00:00.000Z'),
  attemptCount: 2,
  leaseGeneration: 3,
  leaseToken: '22222222-2222-4222-8222-222222222222',
  sealedPayload: {
    ciphertext: 'ciphertext',
    nonce: 'nonce',
    tag: 'tag',
    keyVersion: 'v1',
  },
};

function store() {
  return {
    claim: vi.fn().mockResolvedValue([claim]),
    settle: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  } satisfies AuthenticationMailDeliveryStore;
}

function dependencies(result: unknown) {
  const deliveryStore = store();
  const sendNotification = vi.fn().mockResolvedValue(result);
  return {
    deliveryStore,
    sendNotification,
    handler: createAuthenticationMailDeliveryHandler({
      store: deliveryStore,
      envelope: {
        open: vi.fn().mockReturnValue(
          JSON.stringify({
            fromEmail: 'security@example.test',
            toEmail: 'ada@example.test',
            subject: 'Reset password',
            text: 'Exact immutable body',
          }),
        ),
      },
      email: { sendNotification },
      apiKey: 'provider-key',
      timeoutMillis: 5_000,
      workerId: 'auth-mail:test',
      now: () => new Date('2026-09-23T00:00:00.000Z'),
      random: () => 0,
    }),
  };
}

describe('authentication mail delivery', () => {
  it('submits the immutable encrypted command with a stable provider key', async () => {
    const fixture = dependencies({ kind: 'succeeded', emailId: 'email-1' });
    await expect(fixture.handler.runOnce()).resolves.toBe(1);
    expect(fixture.deliveryStore.claim).toHaveBeenCalledWith({
      workerId: 'auth-mail:test',
      limit: 1,
    });
    expect(fixture.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        fromEmail: 'security@example.test',
        toEmail: 'ada@example.test',
        subject: 'Reset password',
        text: 'Exact immutable body',
        idempotencyKey:
          'authentication-mail:v1:11111111-1111-4111-8111-111111111111',
      }),
    );
    expect(fixture.deliveryStore.settle).toHaveBeenCalledWith({
      id: claim.id,
      leaseToken: claim.leaseToken,
      leaseGeneration: claim.leaseGeneration,
      outcome: 'submitted',
      providerReference: 'email-1',
    });
  });

  it('treats structured 5xx as outcome unknown and retries the exact claim', async () => {
    const fixture = dependencies({
      kind: 'rejected',
      status: 503,
      error: 'provider_unavailable',
    });
    await fixture.handler.runOnce();
    expect(fixture.deliveryStore.settle).toHaveBeenCalledWith({
      id: claim.id,
      leaseToken: claim.leaseToken,
      leaseGeneration: claim.leaseGeneration,
      outcome: 'retry',
      failureCode: 'delivery.outcome_unknown',
      retryAt: new Date('2026-09-23T00:00:02.000Z'),
    });
  });

  it('settles terminal provider rejection without retrying', async () => {
    const fixture = dependencies({
      kind: 'rejected',
      status: 400,
      error: 'invalid_recipient',
    });
    await fixture.handler.runOnce();
    expect(fixture.deliveryStore.settle).toHaveBeenCalledWith({
      id: claim.id,
      leaseToken: claim.leaseToken,
      leaseGeneration: claim.leaseGeneration,
      outcome: 'failed',
      failureCode: 'delivery.provider_rejected',
    });
  });

  it('retains the exact command after provider rate limiting', async () => {
    const fixture = dependencies({
      kind: 'rejected',
      status: 429,
      error: 'rate_limited',
    });
    await fixture.handler.runOnce();
    expect(fixture.deliveryStore.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: claim.id,
        outcome: 'retry',
        failureCode: 'delivery.outcome_unknown',
      }),
    );
  });

  it('does not dispatch a link that expired after it was claimed', async () => {
    const fixture = dependencies({ kind: 'succeeded', emailId: 'email-1' });
    const expired = {
      ...claim,
      expiresAt: new Date('2026-09-22T23:59:59.000Z'),
    };
    vi.mocked(fixture.deliveryStore.claim).mockResolvedValue([expired]);
    await fixture.handler.runOnce();
    expect(fixture.sendNotification).not.toHaveBeenCalled();
    expect(fixture.deliveryStore.settle).toHaveBeenCalledWith({
      id: claim.id,
      leaseToken: claim.leaseToken,
      leaseGeneration: claim.leaseGeneration,
      outcome: 'reconciliation_required',
      failureCode: 'delivery.expired_before_dispatch',
    });
  });

  it('reuses exact provider request bytes and idempotency key after an uncertain result', async () => {
    const requests: { key: string; body: string }[] = [];
    const provider = createResendClient({
      execute: async (request) => {
        requests.push({
          key: request.headers?.['idempotency-key'] ?? '',
          body: new TextDecoder().decode(request.body),
        });
        await request.beforeDispatch();
        return {
          status: requests.length === 1 ? 503 : 200,
          headers: {},
          body: new TextEncoder().encode(
            JSON.stringify(
              requests.length === 1
                ? { name: 'internal_server_error' }
                : { id: '55555555-5555-4555-8555-555555555555' },
            ),
          ),
          bodyEncoding: 'utf8' as const,
          finalUrl: request.url,
          redirectCount: 0,
        };
      },
    });
    const deliveryStore = store();
    const envelope = createApplicationSecretEnvelope({
      current: {
        version: 'v1',
        key: Buffer.alloc(32, 5).toString('base64'),
      },
      previous: [],
    });
    vi.mocked(deliveryStore.claim).mockResolvedValue([
      {
        ...claim,
        sealedPayload: envelope.seal(
          JSON.stringify({
            fromEmail: 'security@example.test',
            toEmail: 'ada@example.test',
            subject: 'Immutable subject',
            text: 'Immutable reset link',
          }),
          `pertexo/authentication-mail/v1/${claim.purpose}/${claim.id}/${claim.expiresAt.toISOString()}`,
        ),
      },
    ]);
    const common = {
      store: deliveryStore,
      envelope,
      email: provider,
      timeoutMillis: 5_000,
      workerId: 'auth-mail:test',
      now: () => new Date('2026-09-23T00:00:00.000Z'),
      random: () => 0,
    };
    await createAuthenticationMailDeliveryHandler({
      ...common,
      apiKey: 'provider-key-v1',
    }).runOnce();
    await createAuthenticationMailDeliveryHandler({
      ...common,
      apiKey: 'provider-key-v2',
    }).runOnce();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(deliveryStore.settle).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ outcome: 'retry' }),
    );
    expect(deliveryStore.settle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ outcome: 'submitted' }),
    );
  });
});
