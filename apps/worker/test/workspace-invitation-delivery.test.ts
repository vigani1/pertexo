import type { WorkspaceInvitationDeliveryStore } from '@pertexo/database/execution';
import type { ResendClient } from '@pertexo/integrations/server';
import { JOB_NAME, type QueueHandlerContext } from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceInvitationDeliveryHandler } from '../src/execution/workspace-invitation-delivery.js';

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
    schemaVersion: 1 as const,
    workspaceId: WORKSPACE_ID,
    invitationId: INVITATION_ID,
    deliveryAttemptId: ATTEMPT_ID,
    outboxEventId: OUTBOX_ID,
  },
  transport: { attemptsMade: 0, jobId: `outbox-${OUTBOX_ID}` },
} as const;

function setup(result: Awaited<ReturnType<ResendClient['sendNotification']>>) {
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
    markDispatching: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const sendNotification = vi.fn<ResendClient['sendNotification']>(
    async (input) => {
      await input.beforeDispatch();
      return result;
    },
  );
  const handler = createWorkspaceInvitationDeliveryHandler({
    store,
    envelope: { open: vi.fn().mockReturnValue('wi1.secret-token') },
    email: { sendNotification },
    apiKey: 're_system',
    fromEmail: 'invites@example.test',
    webOrigin: 'https://app.example.test',
    timeoutMillis: 5_000,
  });
  return { store, sendNotification, handler };
}

describe('workspace invitation delivery', () => {
  it('sends the fixed application-owned template and clears a submitted secret', async () => {
    const test = setup({
      kind: 'succeeded',
      emailId: '55555555-5555-4555-8555-555555555555',
    });

    await test.handler.handle(delivery, context);

    expect(test.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 're_system',
        fromEmail: 'invites@example.test',
        toEmail: 'recipient@example.test',
        idempotencyKey: `workspace-invitation:v1:${ATTEMPT_ID}`,
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
    const test = setup({ kind: 'http_failure', status: 503 });

    await expect(test.handler.handle(delivery, context)).rejects.toThrow(
      'requires reconciliation',
    );

    expect(test.store.markDispatching).toHaveBeenCalledOnce();
    expect(test.store.complete).not.toHaveBeenCalled();
  });

  it('records a definite rejection and clears its sealed delivery material', async () => {
    const test = setup({
      kind: 'rejected',
      error: 'validation_error',
      status: 422,
    });

    await test.handler.handle(delivery, context);

    expect(test.store.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        failureCode: 'delivery.provider_rejected',
      }),
    );
  });
});
