import type { WorkspaceInvitationDeliveryStore } from '@pertexo/database/tenant-access';
import { createWorkspaceInvitationDeliveryStore } from '@pertexo/database/tenant-access';
import {
  createApplicationSecretEnvelope,
  createSystemMailClient,
} from '@pertexo/integrations/server';
import type {
  ApplicationSecretEnvelope,
  SystemMailResult,
  SystemMailClient,
} from '@pertexo/integrations/server';
import type { QueueDelivery, QueueHandlerContext } from '@pertexo/queue';
export const workspaceInvitationDeliveryFactories = Object.freeze({
  store: createWorkspaceInvitationDeliveryStore,
  envelope: createApplicationSecretEnvelope,
  email: createSystemMailClient,
  create: createWorkspaceInvitationDeliveryHandler,
});

type Delivery = Extract<
  QueueDelivery,
  { readonly name: 'deliver-workspace-invitation' }
>;

export interface WorkspaceInvitationDeliveryHandler {
  handle(delivery: Delivery, context: QueueHandlerContext): Promise<void>;
}

export function createWorkspaceInvitationDeliveryHandler(
  dependencies: Readonly<{
    store: WorkspaceInvitationDeliveryStore;
    envelope: Pick<ApplicationSecretEnvelope, 'open'>;
    email: SystemMailClient;
    fromEmail: string;
    webOrigin: string;
    timeoutMillis: number;
  }>,
): WorkspaceInvitationDeliveryHandler {
  // Config parsed the web origin; it has no path.
  const origin = new URL(dependencies.webOrigin);
  return Object.freeze({
    handle: async (
      delivery: Delivery,
      context: QueueHandlerContext,
    ): Promise<void> => {
      await deliver(delivery, context);
      if (context.signal.aborted) return;
      // Only now: a mail server that stays down exhausts the job's retries, and
      // this event must then come back rather than count as delivered.
      await dependencies.store.confirm({
        workspaceId: delivery.data.workspaceId,
        outboxEventId: delivery.data.outboxEventId,
        signal: context.signal,
      });
    },
  });

  async function deliver(
    delivery: Delivery,
    context: QueueHandlerContext,
  ): Promise<void> {
    const identity = {
      workspaceId: delivery.data.workspaceId,
      invitationId: delivery.data.invitationId,
      deliveryAttemptId: delivery.data.deliveryAttemptId,
    };
    const claim = await dependencies.store.claim({
      ...identity,
      outboxEventId: delivery.data.outboxEventId,
      signal: context.signal,
    });
    if (claim.kind === 'terminal' || context.signal.aborted) return;
    if (claim.recoveredUnknown && !dependencies.email.deduplicates) return;
    const associatedData = `pertexo/workspace-invitation/${identity.workspaceId}/${identity.invitationId}/${identity.deliveryAttemptId}`;
    const token = dependencies.envelope.open(claim.sealedToken, associatedData);
    const invitationUrl = new URL('/invitations/accept', origin);
    invitationUrl.hash = `token=${encodeURIComponent(token)}`;
    const dispatch = { held: false };
    const result = await dependencies.email.sendNotification({
      fromEmail: dependencies.fromEmail,
      toEmail: claim.email,
      subject: `Join ${claim.workspaceName} on Pertexo`,
      text: renderInvitation({
        workspaceName: claim.workspaceName,
        role: claim.role,
        expiresAt: claim.expiresAt,
        invitationUrl: invitationUrl.toString(),
      }),
      idempotencyKey: `workspace-invitation:${identity.deliveryAttemptId}`,
      timeoutMillis: dependencies.timeoutMillis,
      signal: context.signal,
      beforeDispatch: async () => {
        const marked = await dependencies.store.markDispatching({
          ...identity,
          recoveredUnknown: claim.recoveredUnknown,
          signal: context.signal,
        });
        if (!marked)
          throw new Error(
            'Workspace invitation delivery is no longer dispatchable',
          );
        dispatch.held = true;
      },
    });
    if (!dependencies.email.deduplicates) {
      if (result.kind === 'unknown') return;
      // Only the copy that marked it may hand it back: another copy of this job may
      // be sending it right now, and `queued` would let a third send it again.
      if (result.kind === 'retryable' && dispatch.held) {
        const queued = await dependencies.store.retry({
          ...identity,
          signal: context.signal,
        });
        if (!queued) return;
      }
    }
    await settleResult(dependencies.store, identity, result, context.signal);
  }
}

function renderInvitation(
  input: Readonly<{
    workspaceName: string;
    role: string;
    expiresAt: Date;
    invitationUrl: string;
  }>,
): string {
  return [
    `You were invited to join ${input.workspaceName} on Pertexo as ${input.role}.`,
    '',
    'Open this single-use link and sign in with the verified email address that received this message:',
    input.invitationUrl,
    '',
    `This invitation expires at ${input.expiresAt.toISOString()}.`,
    'If you did not expect this invitation, you can ignore this message.',
  ].join('\n');
}

async function settleResult(
  store: WorkspaceInvitationDeliveryStore,
  identity: Readonly<{
    workspaceId: string;
    invitationId: string;
    deliveryAttemptId: string;
  }>,
  result: SystemMailResult,
  signal: AbortSignal,
): Promise<void> {
  if (result.kind === 'submitted') {
    await store.complete({
      ...identity,
      status: 'submitted',
      providerReference: result.reference,
      signal,
    });
    return;
  }
  if (result.kind === 'failed') {
    await store.complete({
      ...identity,
      status: 'failed',
      failureCode: 'delivery.provider_rejected',
      signal,
    });
    return;
  }
  // SMTP reaches this point only after definite nonacceptance; Resend can
  // repeat its provider-idempotent command after an uncertain response.
  throw new Error('Workspace invitation delivery requires retry');
}
