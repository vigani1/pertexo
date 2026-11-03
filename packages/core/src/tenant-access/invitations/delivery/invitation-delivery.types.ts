import type { z } from 'zod';
import type { sealedToken } from '../input.js';

export type WorkspaceInvitationDeliveryClaim =
  | Readonly<{ kind: 'terminal' }>
  | Readonly<{
      kind: 'ready';
      recoveredUnknown: boolean;
      email: string;
      workspaceName: string;
      role: string;
      expiresAt: Date;
      sealedToken: z.output<typeof sealedToken>;
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
    status: 'submitted' | 'failed';
    providerReference?: string;
    failureCode?: string;
  }>;
export type ConfirmInvitationDeliveryInput = Readonly<{
  workspaceId: string;
  outboxEventId: string;
  signal?: AbortSignal;
}>;
