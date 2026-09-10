import type {
  FailureNotificationContextV1,
  FailureNotificationDeliveryResultV1,
} from '@pertexo/workflow-model/failure-notification';

export type FailureNotificationDelivery = Readonly<{
  outboxEventId: string;
  payloadChecksum: string;
}>;

export type FailureNotificationClaimResult =
  | Readonly<{ kind: 'busy' | 'terminal' }>
  | Readonly<{
      kind: 'ready';
      attemptNumber: number;
      context: FailureNotificationContextV1;
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
    schemaVersion: 1;
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

export interface FailureNotificationStore {
  claimDelivery(
    input: Readonly<{
      workspaceId: string;
      intentId: string;
      delivery: FailureNotificationDelivery;
      recoverySeconds: number;
      maxAttempts: number;
    }>,
  ): Promise<FailureNotificationClaimResult>;
  completeDelivery(
    input: Readonly<{
      workspaceId: string;
      intentId: string;
      attemptNumber: number;
      maxAttempts: number;
      retryDelaySeconds: number;
      result: FailureNotificationDeliveryResultV1;
    }>,
  ): Promise<'completed' | 'stale'>;
  loadDestination(
    input: Readonly<{
      workspaceId: string;
      intentId: string;
      attemptNumber: number;
      workerId: string;
      signal: AbortSignal;
    }>,
  ): Promise<FailureNotificationResolvedDestination>;
  fenceDispatch(
    input: Readonly<{
      workspaceId: string;
      intentId: string;
      attemptNumber: number;
      deliveryBinding?: string;
    }>,
  ): Promise<void>;
  recoverDue(limit: number, maxAttempts: number): Promise<number>;
  close(): Promise<void>;
}
