import type { FailureNotificationStore } from '@pertexo/database/execution';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/execution';
import type { QueueDelivery, QueueHandlerContext } from '@pertexo/queue';
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

export interface FailureNotificationHandler {
  handle(delivery: Delivery, queueContext: QueueHandlerContext): Promise<void>;
  pendingOperations(): readonly Promise<void>[];
}

function deliveryFailureCode(
  signal: AbortSignal,
): 'delivery.provider_failure' | 'delivery.timeout' {
  return signal.aborted ? 'delivery.timeout' : 'delivery.provider_failure';
}

export function createFailureNotificationHandler(
  dependencies: Readonly<{
    store: FailureNotificationStore;
    delivery: FailureNotificationDeliveryCapability;
    timeoutMillis: number;
    maxAttempts: number;
    retryDelaySeconds: number;
  }>,
): FailureNotificationHandler {
  if (
    !Number.isSafeInteger(dependencies.timeoutMillis) ||
    dependencies.timeoutMillis < 1 ||
    dependencies.timeoutMillis > 120_000 ||
    !Number.isSafeInteger(dependencies.maxAttempts) ||
    dependencies.maxAttempts < 1 ||
    dependencies.maxAttempts > 100 ||
    !Number.isSafeInteger(dependencies.retryDelaySeconds) ||
    dependencies.retryDelaySeconds < 1 ||
    dependencies.retryDelaySeconds > 86_400
  )
    throw new TypeError('Failure notification delivery bounds are invalid');
  const pendingOperations = new Set<Promise<void>>();
  const trackPending = (operation: Promise<unknown>): void => {
    const observed = operation
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        pendingOperations.delete(observed);
      });
    pendingOperations.add(observed);
  };
  return Object.freeze({
    pendingOperations: () => [...pendingOperations],
    handle: async (
      delivery: Delivery,
      queueContext: QueueHandlerContext,
    ): Promise<void> => {
      const controller = new AbortController();
      const onQueueAbort = (): void => {
        controller.abort(queueContext.signal.reason);
      };
      if (queueContext.signal.aborted) return;
      queueContext.signal.addEventListener('abort', onQueueAbort, {
        once: true,
      });
      try {
        const claimPromise = dependencies.store.claimDelivery({
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
          signal: queueContext.signal,
        });
        const claimSettlement = await settleUntilAbort(
          claimPromise,
          queueContext.signal,
        );
        if (claimSettlement.kind === 'aborted') {
          trackPending(claimPromise);
          return;
        }
        if (claimSettlement.kind === 'rejected') {
          // Preserve legacy non-Error persistence rejection values.
          throw claimSettlement.reason;
        }
        const claim = claimSettlement.value;
        if (claim.kind !== 'ready' || controller.signal.aborted) return;
        const timeout = setTimeout(() => {
          controller.abort(new Error('failure notification delivery timeout'));
        }, dependencies.timeoutMillis);
        let result: FailureNotificationDeliveryResultV1;
        try {
          let deliveryPromise: Promise<unknown>;
          try {
            deliveryPromise = Promise.resolve(
              dependencies.delivery.deliver({
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
          } catch (error: unknown) {
            // Preserve hostile legacy rejection values for conservative mapping.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            deliveryPromise = Promise.reject(error);
          }
          const settlement = await settleUntilAbort(
            deliveryPromise,
            controller.signal,
          );
          if (settlement.kind === 'aborted') {
            trackPending(deliveryPromise);
            return;
          }
          // Queue cancellation can arrive while provider work is awaiting I/O.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (queueContext.signal.aborted) return;
          if (settlement.kind === 'rejected') throw settlement.reason;
          result = FailureNotificationDeliveryResultV1Schema.parse(
            settlement.value,
          );
        } catch {
          result = {
            schemaVersion: 1,
            kind: 'retry',
            safeErrorCode: deliveryFailureCode(controller.signal),
            possiblyDispatched: true,
          };
        } finally {
          clearTimeout(timeout);
        }
        const completionPromise = dependencies.store.completeDelivery({
          workspaceId: delivery.data.workspaceId,
          intentId: delivery.data.notificationIntentId,
          attemptNumber: claim.attemptNumber,
          maxAttempts: dependencies.maxAttempts,
          retryDelaySeconds: dependencies.retryDelaySeconds,
          result,
          signal: queueContext.signal,
        });
        const completion = await settleUntilAbort(
          completionPromise,
          queueContext.signal,
        );
        if (completion.kind === 'aborted') {
          trackPending(completionPromise);
          return;
        }
        if (completion.kind === 'rejected') {
          // Preserve legacy non-Error persistence rejection values.
          throw completion.reason;
        }
      } finally {
        queueContext.signal.removeEventListener('abort', onQueueAbort);
      }
    },
  });
}

type DeliverySettlement<T> =
  | Readonly<{ kind: 'fulfilled'; value: T }>
  | Readonly<{ kind: 'rejected'; reason: unknown }>
  | Readonly<{ kind: 'aborted' }>;

function settleUntilAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<DeliverySettlement<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DeliverySettlement<T>): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      // Give an abort-cooperating provider's already-triggered rejection one
      // microtask to settle. A provider that ignores cancellation remains
      // detached and observed without blocking its runtime owner.
      queueMicrotask(() => {
        finish({ kind: 'aborted' });
      });
    };
    operation.then(
      (value) => {
        finish({ kind: 'fulfilled', value });
      },
      (reason: unknown) => {
        finish({ kind: 'rejected', reason });
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}
