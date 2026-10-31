import type { WorkspaceInvitationDeliveryStore } from '@pertexo/database/tenant-access';
import {
  createSystemMailClient,
  type SystemMailClient,
} from '@pertexo/integrations/server';
import { JOB_NAME, type QueueHandlerContext } from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceInvitationDeliveryHandler } from '../../src/identity/invitation-delivery.js';

/* eslint-disable @typescript-eslint/unbound-method -- assertions target injected seam fakes */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const INVITATION_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const OUTBOX_ID = '44444444-4444-4444-8444-444444444444';
const context: QueueHandlerContext = {
  signal: new AbortController().signal,
};
const delivery = {
  name: JOB_NAME.deliverWorkspaceInvitation,
  data: {
    workspaceId: WORKSPACE_ID,
    invitationId: INVITATION_ID,
    deliveryAttemptId: ATTEMPT_ID,
    outboxEventId: OUTBOX_ID,
  },
  transport: { attemptsMade: 0, jobId: `outbox-${OUTBOX_ID}` },
} as const;

function setup(
  result: Awaited<ReturnType<SystemMailClient['sendNotification']>>,
) {
  const store: WorkspaceInvitationDeliveryStore = {
    claim: vi.fn().mockResolvedValue({
      kind: 'ready',
      email: 'recipient@example.test',
      workspaceName: 'Acme workspace',
      role: 'builder',
      expiresAt: new Date('2026-09-26T12:00:00.000Z'),
      sealedToken: {
        ciphertext: 'ciphertext',
        nonce: 'nonce',
        tag: 'tag',
        keyVersion: 'invite-v1',
      },
    }),
    retry: vi.fn().mockResolvedValue(true),
    markDispatching: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const sendNotification = vi.fn<SystemMailClient['sendNotification']>(
    async (input) => {
      await input.beforeDispatch();
      return result;
    },
  );
  const handler = createWorkspaceInvitationDeliveryHandler({
    store,
    envelope: { open: vi.fn().mockReturnValue('wi1.secret-token') },
    email: { sendNotification, deduplicates: true },

    fromEmail: 'invites@example.test',
    webOrigin: 'https://app.example.test',
    timeoutMillis: 5_000,
  });
  return { store, sendNotification, handler };
}

describe('workspace invitation delivery', () => {
  // A late job and its redelivery can run together. The one that lost the race to
  // mark the attempt must not hand it back while the winner may be sending it.
  it('leaves the attempt alone when another copy of the job holds it', async () => {
    const test = setup({ kind: 'retryable' });
    const smtp = createWorkspaceInvitationDeliveryHandler({
      store: {
        ...test.store,
        markDispatching: vi.fn().mockResolvedValue(false),
      },
      envelope: { open: vi.fn().mockReturnValue('wi1.secret-token') },
      email: {
        deduplicates: false,
        sendNotification: async (input) => {
          await input.beforeDispatch().catch(() => undefined);
          return { kind: 'retryable' };
        },
      },
      fromEmail: 'invites@example.test',
      webOrigin: 'https://app.example.test',
      timeoutMillis: 5_000,
    });

    await expect(smtp.handle(delivery, context)).rejects.toThrow(
      'requires retry',
    );

    expect(test.store.retry).not.toHaveBeenCalled();
    expect(test.store.confirm).not.toHaveBeenCalled();
  });

  it('confirms the job only once it has been handled', async () => {
    const test = setup({ kind: 'retryable' });

    await expect(test.handler.handle(delivery, context)).rejects.toThrow(
      'requires retry',
    );
    expect(test.store.confirm).not.toHaveBeenCalled();

    const sent = setup({
      kind: 'submitted',
      reference: '55555555-5555-4555-8555-555555555555',
    });
    await sent.handler.handle(delivery, context);
    expect(sent.store.confirm).toHaveBeenCalledOnce();
  });

  it('sends the fixed application-owned template and clears a submitted secret', async () => {
    const test = setup({
      kind: 'submitted',
      reference: '55555555-5555-4555-8555-555555555555',
    });

    await test.handler.handle(delivery, context);

    expect(test.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        fromEmail: 'invites@example.test',
        toEmail: 'recipient@example.test',
        idempotencyKey: `workspace-invitation:${ATTEMPT_ID}`,
        subject: 'Join Acme workspace on Pertexo',
      }),
    );
    expect(test.sendNotification.mock.calls[0]?.[0].text).toContain(
      'https://app.example.test/invitations/accept#token=wi1.secret-token',
    );
    expect(test.store.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'submitted',
        deliveryAttemptId: ATTEMPT_ID,
      }),
    );
  });

  it('retains the exact attempt for retryable and uncertain provider outcomes', async () => {
    const test = setup({ kind: 'retryable' });

    await expect(test.handler.handle(delivery, context)).rejects.toThrow(
      'requires retry',
    );

    expect(test.store.markDispatching).toHaveBeenCalledOnce();
    expect(test.store.complete).not.toHaveBeenCalled();
  });

  it('records a definite rejection and clears its sealed delivery material', async () => {
    const test = setup({ kind: 'failed' });

    await test.handler.handle(delivery, context);

    expect(test.store.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        failureCode: 'delivery.provider_rejected',
      }),
    );
  });

  it('retains the attempt when the real client parses a provider 5xx body', async () => {
    const test = setup({ kind: 'retryable' });
    const realClient = createSystemMailClient(
      { mode: 'resend', apiKey: 'provider-key' },
      {
        execute: async (request) => {
          if (
            request.body !== undefined &&
            !(request.body instanceof Uint8Array)
          )
            throw new Error('Expected inline mail body');
          await request.beforeDispatch();
          return {
            status: 500,
            headers: {},
            body: new TextEncoder().encode(
              JSON.stringify({ name: 'internal_server_error' }),
            ),
            bodyEncoding: 'utf8' as const,
            finalUrl: request.url,
            redirectCount: 0,
          };
        },
      },
    );
    const handler = createWorkspaceInvitationDeliveryHandler({
      store: test.store,
      envelope: { open: vi.fn().mockReturnValue('wi1.secret-token') },
      email: realClient,

      fromEmail: 'invites@example.test',
      webOrigin: 'https://app.example.test',
      timeoutMillis: 5_000,
    });

    await expect(handler.handle(delivery, context)).rejects.toThrow(
      'requires retry',
    );
    expect(test.store.markDispatching).toHaveBeenCalledOnce();
    expect(test.store.complete).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'success',
      status: 200,
      body: { id: '55555555-5555-4555-8555-555555555555' },
      outcome: 'submitted',
    },
    {
      label: 'permanent rejection',
      status: 422,
      body: { name: 'validation_error' },
      outcome: 'failed',
    },
    {
      label: 'concurrent idempotency',
      status: 409,
      body: { name: 'concurrent_idempotent_requests' },
      outcome: 'retry',
    },
  ])(
    'classifies real client $label responses at the worker seam',
    async (testCase) => {
      const test = setup({ kind: 'retryable' });
      const requests: { key: string; body: string }[] = [];
      const realClient = createSystemMailClient(
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
              status: testCase.status,
              headers: {},
              body: new TextEncoder().encode(JSON.stringify(testCase.body)),
              bodyEncoding: 'utf8' as const,
              finalUrl: request.url,
              redirectCount: 0,
            };
          },
        },
      );
      const handler = createWorkspaceInvitationDeliveryHandler({
        store: test.store,
        envelope: { open: vi.fn().mockReturnValue('wi1.secret-token') },
        email: realClient,

        fromEmail: 'invites@example.test',
        webOrigin: 'https://app.example.test',
        timeoutMillis: 5_000,
      });

      if (testCase.outcome === 'retry')
        await expect(handler.handle(delivery, context)).rejects.toThrow(
          'requires retry',
        );
      else await handler.handle(delivery, context);
      expect(requests).toHaveLength(1);
      if (testCase.outcome === 'retry')
        expect(test.store.complete).not.toHaveBeenCalled();
      else
        expect(test.store.complete).toHaveBeenCalledWith(
          expect.objectContaining({ status: testCase.outcome }),
        );
    },
  );

  it('renders identical provider commands when an uncertain attempt is redelivered', async () => {
    const test = setup({ kind: 'retryable' });
    await expect(test.handler.handle(delivery, context)).rejects.toThrow();
    await expect(test.handler.handle(delivery, context)).rejects.toThrow();
    const [first, second] = test.sendNotification.mock.calls.map(([input]) => ({
      body: input.text,
      key: input.idempotencyKey,
      subject: input.subject,
    }));
    expect(second).toEqual(first);
  });
});

describe('SMTP invitation recovery', () => {
  function smtp(
    result: Awaited<ReturnType<SystemMailClient['sendNotification']>>,
  ) {
    const fixture = setup(result);
    const handler = createWorkspaceInvitationDeliveryHandler({
      store: fixture.store,
      envelope: { open: () => 'wi1.token' },
      email: {
        deduplicates: false,
        sendNotification: fixture.sendNotification,
      },
      fromEmail: 'invites@example.test',
      webOrigin: 'https://app.example.test',
      timeoutMillis: 5000,
    });
    return { ...fixture, handler };
  }
  it('acknowledges an unknown result without completing or retrying the attempt', async () => {
    const fixture = smtp({ kind: 'unknown' });
    await fixture.handler.handle(delivery, context);
    expect(fixture.store.retry).not.toHaveBeenCalled();
    expect(fixture.store.complete).not.toHaveBeenCalled();
  });
  it('does not repeat an attempt recovered after a crash', async () => {
    const fixture = smtp({ kind: 'submitted', reference: 'unexpected' });
    vi.mocked(fixture.store.claim).mockResolvedValue({
      kind: 'ready',
      recoveredUnknown: true,
      email: 'a@example.test',
      workspaceName: 'Acme',
      role: 'builder',
      expiresAt: new Date(),
      sealedToken: {
        ciphertext: 'ciphertext',
        nonce: 'nonce',
        tag: 'tag',
        keyVersion: 'v1',
      },
    });
    await fixture.handler.handle(delivery, context);
    expect(fixture.sendNotification).not.toHaveBeenCalled();
    expect(fixture.store.retry).not.toHaveBeenCalled();
  });
  it('requeues the same command after known nonacceptance', async () => {
    const fixture = smtp({ kind: 'retryable' });
    await expect(fixture.handler.handle(delivery, context)).rejects.toThrow(
      'requires retry',
    );
    expect(fixture.store.retry).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryAttemptId: ATTEMPT_ID }),
    );
  });
  it('does not retry an invitation superseded while the relay rejected it', async () => {
    const fixture = smtp({ kind: 'retryable' });
    vi.mocked(fixture.store.retry).mockResolvedValue(false);
    await fixture.handler.handle(delivery, context);
    expect(fixture.store.complete).not.toHaveBeenCalled();
  });
});
