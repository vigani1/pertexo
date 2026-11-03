import type {
  FailureNotificationContext,
  FailureNotificationDeliveryResult,
} from '@pertexo/workflow-model';

export type FailureNotificationDelivery = Readonly<{
  outboxEventId: string;
  payloadChecksum: string;
}>;

export type FailureNotificationClaimResult =
  | Readonly<{ kind: 'busy' | 'terminal' }>
  | Readonly<{
      kind: 'ready';
      attemptNumber: number;
      context: FailureNotificationContext;
      destinationId: string;
      destinationConfigVersion: number;
      idempotencyKey: string;
      sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe';
      connectionSecretVersionId: string;
      deliveryBinding?: string;
      deliveryUnresolved: boolean;
    }>;

type FailureNotificationResolvedDestinationBase = Readonly<{
  connectionId: string;
  secretVersionId: string;
  sealed: Readonly<{
    kmsKeyReference: string;
    encryptedDataKey: string;
    ciphertext: string;
    nonce: string;
    tag: string;
  }>;
}>;

export type FailureNotificationResolvedDestination =
  | (FailureNotificationResolvedDestinationBase &
      Readonly<{ kind: 'slack'; channelId: string }>)
  | (FailureNotificationResolvedDestinationBase &
      Readonly<{ kind: 'email'; toEmail: string }>);

type NotificationAttempt = Readonly<{
  workspaceId: string;
  intentId: string;
}>;

export type ClaimDeliveryInput = NotificationAttempt &
  Readonly<{
    delivery: FailureNotificationDelivery;
    recoverySeconds: number;
    maxAttempts: number;
    signal?: AbortSignal;
  }>;

export type CompleteDeliveryInput = NotificationAttempt &
  Readonly<{
    attemptNumber: number;
    maxAttempts: number;
    retryDelaySeconds: number;
    result: FailureNotificationDeliveryResult;
    signal?: AbortSignal;
  }>;

export type LoadDestinationInput = NotificationAttempt &
  Readonly<{
    attemptNumber: number;
    workerId: string;
    signal: AbortSignal;
  }>;

export type FenceDispatchInput = NotificationAttempt &
  Readonly<{
    attemptNumber: number;
    deliveryBinding?: string;
    signal?: AbortSignal;
  }>;
