import type { FailureNotificationStore } from '@pertexo/database/execution';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/execution';
import {
  jobIdForOutboxEvent,
  type QueueDelivery,
  type QueueHandlerContext,
} from '@pertexo/queue';
import {
  FailureNotificationDeliveryResultV1Schema,
  type FailureNotificationContextV1,
  type FailureNotificationDeliveryResultV1,
} from '@pertexo/workflow-model/failure-notification';

type Delivery = Extract<
  QueueDelivery,
  { readonly name: 'deliver-run-failure-notification' }
>;

export interface FailureNotificationDeliveryCapability {
  deliver(
    input: Readonly<{
      context: FailureNotificationContextV1;
      workspaceId: string;
      intentId: string;
      attemptNumber: number;
      destinationId: string;
      destinationConfigVersion: number;
      idempotencyKey: string;
      sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe';
      connectionSecretVersionId: string;
      deliveryBinding?: string;
      deliveryUnresolved: boolean;
      signal: AbortSignal;
    }>,
  ): Promise<FailureNotificationDeliveryResultV1>;
}

export function createFailureNotificationHandler(
  dependencies: Readonly<{
    store: FailureNotificationStore;
    delivery: FailureNotificationDeliveryCapability;
    timeoutMillis: number;
    maxAttempts: number;
    retryDelaySeconds: number;
  }>,
) {
  return Object.freeze({
    handle: async (
      delivery: Delivery,
      queueContext: QueueHandlerContext,
    ): Promise<void> => {
      if (
        delivery.transport.jobId !==
        jobIdForOutboxEvent(delivery.data.outboxEventId)
      )
        throw new TypeError('Failure notification transport identity mismatch');
      const claim = await dependencies.store.claimDelivery({
        workspaceId: delivery.data.workspaceId,
        intentId: delivery.data.notificationIntentId,
        delivery: {
          outboxEventId: delivery.data.outboxEventId,
          payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
        },
        recoverySeconds: Math.max(
          1,
          Math.ceil(dependencies.timeoutMillis / 1_000) + 1,
        ),
        maxAttempts: dependencies.maxAttempts,
      });
      if (claim.kind !== 'ready') return;
      const controller = new AbortController();
      const onQueueAbort = (): void => {
        controller.abort(queueContext.signal.reason);
      };
      queueContext.signal.addEventListener('abort', onQueueAbort, {
        once: true,
      });
      const timeout = setTimeout(() => {
        controller.abort(new Error('failure notification delivery timeout'));
      }, dependencies.timeoutMillis);
      let result: FailureNotificationDeliveryResultV1;
      try {
        result = FailureNotificationDeliveryResultV1Schema.parse(
          await dependencies.delivery.deliver({
            context: claim.context,
            workspaceId: delivery.data.workspaceId,
            intentId: delivery.data.notificationIntentId,
            attemptNumber: claim.attemptNumber,
            destinationId: claim.destinationId,
            destinationConfigVersion: claim.destinationConfigVersion,
            idempotencyKey: claim.idempotencyKey,
            sideEffectClass: claim.sideEffectClass,
            connectionSecretVersionId: claim.connectionSecretVersionId,
            deliveryUnresolved: claim.deliveryUnresolved,
            ...(claim.deliveryBinding === undefined
              ? {}
              : { deliveryBinding: claim.deliveryBinding }),
            signal: controller.signal,
          }),
        );
      } catch {
        result = {
          schemaVersion: 1,
          kind: 'retry',
          safeErrorCode: controller.signal.aborted
            ? 'delivery.timeout'
            : 'delivery.provider_failure',
          possiblyDispatched: true,
        };
      } finally {
        clearTimeout(timeout);
        queueContext.signal.removeEventListener('abort', onQueueAbort);
      }
      await dependencies.store.completeDelivery({
        workspaceId: delivery.data.workspaceId,
        intentId: delivery.data.notificationIntentId,
        attemptNumber: claim.attemptNumber,
        maxAttempts: dependencies.maxAttempts,
        retryDelaySeconds: dependencies.retryDelaySeconds,
        result,
      });
    },
  });
}
