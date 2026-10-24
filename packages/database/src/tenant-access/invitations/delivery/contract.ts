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

export interface WorkspaceInvitationDeliveryStore {
  claim(
    input: Readonly<{
      workspaceId: string;
      invitationId: string;
      deliveryAttemptId: string;
      outboxEventId: string;
      signal?: AbortSignal;
    }>,
  ): Promise<WorkspaceInvitationDeliveryClaim>;
  markDispatching(
    input: Readonly<{
      workspaceId: string;
      invitationId: string;
      deliveryAttemptId: string;
      signal?: AbortSignal;
    }>,
  ): Promise<boolean>;
  retry(
    input: Readonly<{
      workspaceId: string;
      invitationId: string;
      deliveryAttemptId: string;
      signal?: AbortSignal;
    }>,
  ): Promise<boolean>;
  complete(
    input: Readonly<{
      workspaceId: string;
      invitationId: string;
      deliveryAttemptId: string;
      status: 'submitted' | 'failed';
      providerReference?: string;
      failureCode?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<void>;
  close(): Promise<void>;
}
