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
  /**
   * False when another delivery of this attempt got there first. A claim of a
   * `queued` attempt may only take it from `queued`: two copies of one job can
   * both read it, and only one of them may send.
   */
  markDispatching(
    input: Readonly<{
      workspaceId: string;
      invitationId: string;
      deliveryAttemptId: string;
      recoveredUnknown: boolean;
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
  /** This event's job is done: nothing needs to deliver it again. */
  confirm(
    input: Readonly<{
      workspaceId: string;
      outboxEventId: string;
      signal?: AbortSignal;
    }>,
  ): Promise<void>;
  close(): Promise<void>;
}
