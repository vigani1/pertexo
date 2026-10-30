import type { SystemMailDeliveryStore } from '@pertexo/database/platform';
import {
  createApplicationSecretEnvelope,
  createSystemMailClient,
} from '@pertexo/integrations/server';
import { describe, expect, it, vi } from 'vitest';

import { createSystemMailDeliveryHandler } from '../../src/mail/delivery.js';

const claim = {
  id: '11111111-1111-4111-8111-111111111111',
  purpose: 'password_reset' as const,
  expiresAt: new Date('2026-09-23T01:00:00.000Z'),
  attemptCount: 2,
  recoveredUnknown: false,
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
  } satisfies SystemMailDeliveryStore;
}

function dependencies(result: unknown, unsubscribeUrl?: string) {
  const deliveryStore = store();
  const sendNotification = vi.fn().mockResolvedValue(result);
  return {
    deliveryStore,
    sendNotification,
    handler: createSystemMailDeliveryHandler({
      store: deliveryStore,
      envelope: {
        open: vi.fn().mockReturnValue(
          JSON.stringify({
            fromEmail: 'security@example.test',
            toEmail: 'ada@example.test',
            subject: 'Reset password',
            text: 'Exact immutable body',
            ...(unsubscribeUrl === undefined ? {} : { unsubscribeUrl }),
          }),
        ),
      },
      email: { sendNotification, deduplicates: true },

      timeoutMillis: 5_000,
      workerId: 'auth-mail:test',
      now: () => new Date('2026-09-23T00:00:00.000Z'),
      random: () => 0,
    }),
  };
}

describe('system mail delivery', () => {
  it('submits the immutable encrypted command with a stable provider key', async () => {
    const fixture = dependencies({ kind: 'submitted', reference: 'email-1' });
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
          'authentication-mail:11111111-1111-4111-8111-111111111111',
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

  // worker-10: a retryable result was definitely not sent; recording it as
  // outcome unknown blurs it with a message that may have gone out.
  it.fails(
    'records a retryable provider result as not sent and retries the exact claim',
    async () => {
      const fixture = dependencies({ kind: 'retryable' });
      await fixture.handler.runOnce();
      expect(fixture.deliveryStore.settle).toHaveBeenCalledWith({
        id: claim.id,
        leaseToken: claim.leaseToken,
        leaseGeneration: claim.leaseGeneration,
        outcome: 'retry',
        failureCode: 'delivery.retryable',
        retryAt: new Date('2026-09-23T00:00:02.000Z'),
      });
    },
  );

  it('settles terminal provider rejection without retrying', async () => {
    const fixture = dependencies({ kind: 'failed' });
    await fixture.handler.runOnce();
    expect(fixture.deliveryStore.settle).toHaveBeenCalledWith({
      id: claim.id,
      leaseToken: claim.leaseToken,
      leaseGeneration: claim.leaseGeneration,
      outcome: 'failed',
      failureCode: 'delivery.provider_rejected',
    });
  });

  // worker-10: rate limiting is a definite refusal, not an unknown outcome.
  it.fails(
    'retains the exact command after provider rate limiting',
    async () => {
      const fixture = dependencies({ kind: 'retryable' });
      await fixture.handler.runOnce();
      expect(fixture.deliveryStore.settle).toHaveBeenCalledWith(
        expect.objectContaining({
          id: claim.id,
          outcome: 'retry',
          failureCode: 'delivery.retryable',
        }),
      );
    },
  );

  it('does not dispatch a link that expired after it was claimed', async () => {
    const fixture = dependencies({ kind: 'submitted', reference: 'email-1' });
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
    const provider = createSystemMailClient(
      { mode: 'resend', apiKey: 'provider-key' },
      {
        execute: async (request) => {
          if (
            request.body !== undefined &&
            !(request.body instanceof Uint8Array)
          )
            throw new Error('Expected inline mail body');
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
      },
    );
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
          `pertexo/authentication-mail/${claim.purpose}/${claim.id}/${claim.expiresAt.toISOString()}`,
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
    await createSystemMailDeliveryHandler({
      ...common,
    }).runOnce();
    await createSystemMailDeliveryHandler({
      ...common,
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

describe('non-idempotent SMTP recovery', () => {
  it('never repeats a recovered unknown command', async () => {
    const fixture = dependencies({
      kind: 'submitted',
      reference: 'unexpected',
    });
    vi.mocked(fixture.deliveryStore.claim).mockResolvedValue([
      { ...claim, recoveredUnknown: true },
    ]);
    const handler = createSystemMailDeliveryHandler({
      store: fixture.deliveryStore,
      envelope: { open: vi.fn() },
      email: {
        deduplicates: false,
        sendNotification: fixture.sendNotification,
      },
      timeoutMillis: 5000,
      workerId: 'smtp:test',
    });
    await handler.runOnce();
    expect(fixture.sendNotification).not.toHaveBeenCalled();
    expect(fixture.deliveryStore.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'reconciliation_required',
        failureCode: 'delivery.recovered_unknown',
      }),
    );
  });
  it('settles an unknown SMTP result without scheduling a retry', async () => {
    const fixture = dependencies({ kind: 'unknown' });
    const handler = createSystemMailDeliveryHandler({
      store: fixture.deliveryStore,
      envelope: {
        open: () =>
          JSON.stringify({
            fromEmail: 'a@example.test',
            toEmail: 'b@example.test',
            subject: 'Test',
            text: 'Test',
          }),
      },
      email: {
        deduplicates: false,
        sendNotification: fixture.sendNotification,
      },
      timeoutMillis: 5000,
      workerId: 'smtp:test',
      now: () => new Date('2026-09-23T00:00:00Z'),
    });
    await handler.runOnce();
    expect(fixture.deliveryStore.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'reconciliation_required',
        failureCode: 'delivery.outcome_unknown',
      }),
    );
  });
});

it.each(['https://app.example.test', 'http://127.0.0.1:4174'])(
  'keeps a sealed %s notice URL and both Resend headers identical across an uncertain retry',
  async (origin) => {
    const deliveryStore = store();
    const envelope = createApplicationSecretEnvelope({
      current: { version: 'v1', key: Buffer.alloc(32, 5).toString('base64') },
    });
    const unsubscribeUrl = `${origin}/v1/notifications/unsubscribe/one-click?token=immutable`;
    const sealedPayload = envelope.seal(
      JSON.stringify({
        fromEmail: 'security@example.test',
        toEmail: 'ada@example.test',
        subject: 'Workflow failed: Import — Workspace',
        text: 'Safe names only',
        unsubscribeUrl,
      }),
      `pertexo/authentication-mail/workspace_notice/${claim.id}/${claim.expiresAt.toISOString()}`,
    );
    vi.mocked(deliveryStore.claim).mockResolvedValue([
      { ...claim, purpose: 'workspace_notice', sealedPayload },
    ]);
    const requests: { key: string; body: string }[] = [];
    const provider = createSystemMailClient(
      { mode: 'resend', apiKey: 'provider-key' },
      {
        execute: async (request) => {
          if (
            request.body !== undefined &&
            !(request.body instanceof Uint8Array)
          )
            throw new Error('Expected inline mail body');
          requests.push({
            key: request.headers?.['idempotency-key'] ?? '',
            body: new TextDecoder().decode(request.body),
          });
          await request.beforeDispatch();
          return {
            status: 503,
            headers: {},
            body: new TextEncoder().encode('{}'),
            bodyEncoding: 'utf8',
            finalUrl: request.url,
            redirectCount: 0,
          };
        },
      },
    );
    const handler = createSystemMailDeliveryHandler({
      store: deliveryStore,
      envelope,
      email: provider,
      timeoutMillis: 5000,
      workerId: 'notice-test',
      now: () => new Date('2026-09-23T00:00:00Z'),
      notices: {
        prepare: () => Promise.resolve(0),
        authorize: () => Promise.resolve(true),
      },
    });
    await handler.runOnce();
    await handler.runOnce();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(JSON.parse(requests[0]?.body ?? '{}')).toMatchObject({
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
  },
);

it.each([
  'file:///tmp/private',
  'ftp://app.example.test',
  'javascript:alert(1)',
])(
  'refuses a non-HTTP unsubscribe URL before dispatch: %s',
  async (unsubscribeUrl) => {
    const fixture = dependencies(
      { kind: 'submitted', reference: 'must-not-send' },
      unsubscribeUrl,
    );
    await expect(fixture.handler.runOnce()).rejects.toThrow();
    expect(fixture.sendNotification).not.toHaveBeenCalled();
  },
);
