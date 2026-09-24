import type { WorkspaceInvitationDeliveryStore } from '@pertexo/database/execution';
import type {
  ApplicationSecretEnvelope,
  ResendApiResult,
  ResendClient,
} from '@pertexo/integrations/server';
import type { QueueDelivery, QueueHandlerContext } from '@pertexo/queue';

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
    email: Pick<ResendClient, 'sendNotification'>;
    apiKey: string;
    fromEmail: string;
    webOrigin: string;
    timeoutMillis: number;
  }>,
): WorkspaceInvitationDeliveryHandler {
  const origin = new URL(dependencies.webOrigin);
  if (origin.pathname !== '/' || origin.search !== '' || origin.hash !== '')
    throw new TypeError('Invitation web origin must not include a path');
  return Object.freeze({
    handle: async (
      delivery: Delivery,
      context: QueueHandlerContext,
    ): Promise<void> => {
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
      const associatedData = `pertexo/workspace-invitation/${identity.workspaceId}/${identity.invitationId}/${identity.deliveryAttemptId}`;
      const token = dependencies.envelope.open(
        claim.sealedToken,
        associatedData,
      );
      const invitationUrl = new URL('/invitations/accept', origin);
      invitationUrl.hash = `token=${encodeURIComponent(token)}`;
      const result = await dependencies.email.sendNotification({
        apiKey: dependencies.apiKey,
        fromEmail: dependencies.fromEmail,
        toEmail: claim.email,
        subject: `Join ${claim.workspaceName} on Pertexo`,
        text: renderInvitation({
          workspaceName: claim.workspaceName,
          role: claim.role,
          expiresAt: claim.expiresAt,
          invitationUrl: invitationUrl.toString(),
        }),
        idempotencyKey: `workspace-invitation:v1:${identity.deliveryAttemptId}`,
        timeoutMillis: dependencies.timeoutMillis,
        signal: context.signal,
        beforeDispatch: async () => {
          const marked = await dependencies.store.markDispatching({
            ...identity,
            signal: context.signal,
          });
          if (!marked)
            throw new Error(
              'Workspace invitation delivery is no longer dispatchable',
            );
        },
      });
      await settleResult(dependencies.store, identity, result, context.signal);
    },
  });
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
  result: ResendApiResult,
  signal: AbortSignal,
): Promise<void> {
  if (result.kind === 'succeeded') {
    await store.complete({
      ...identity,
      status: 'submitted',
      providerReference: result.emailId,
      signal,
    });
    return;
  }
  if (
    result.kind === 'rejected' &&
    result.status < 500 &&
    result.error !== 'concurrent_idempotent_requests'
  ) {
    await store.complete({
      ...identity,
      status: 'failed',
      failureCode: 'delivery.provider_rejected',
      signal,
    });
    return;
  }
  // Preserve the sealed attempt and throw so transport redelivery repeats the
  // same provider-idempotent command instead of minting another link.
  throw new Error('Workspace invitation delivery requires reconciliation');
}
