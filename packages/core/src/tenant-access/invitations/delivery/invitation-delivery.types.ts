import type { ApplicationSealedSecret } from '@pertexo/secrets/server';

export type WorkspaceInvitationDeliveryClaim =
  | Readonly<{ kind: 'terminal' }>
  | Readonly<{
      kind: 'ready';
      recoveredUnknown: boolean;
      email: string;
      workspaceName: string;
      role: string;
      expiresAt: Date;
      sealedToken: ApplicationSealedSecret;
    }>;

type DeliveryAttempt = Readonly<{
  workspaceId: string;
  invitationId: string;
  deliveryAttemptId: string;
  signal?: AbortSignal;
}>;
export type ClaimInvitationDeliveryInput = DeliveryAttempt &
  Readonly<{ outboxEventId: string }>;
export type MarkInvitationDeliveryDispatchingInput = DeliveryAttempt &
  Readonly<{ recoveredUnknown: boolean }>;
export type RetryInvitationDeliveryInput = DeliveryAttempt;
export type CompleteInvitationDeliveryInput = DeliveryAttempt &
  Readonly<{
    status: 'submitted' | 'failed' | 'unknown';
    providerReference?: string;
    failureCode?: string;
  }>;
export type ConfirmInvitationDeliveryInput = Readonly<{
  workspaceId: string;
  outboxEventId: string;
  signal?: AbortSignal;
}>;
