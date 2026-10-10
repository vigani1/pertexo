import type { FailureNotificationStore } from '@pertexo/database/notifications';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/outbox';
import type { QueueDelivery, QueueHandlerContext } from '@pertexo/queue';
import type {
  FailureNotificationContext,
  FailureNotificationDeliveryResult,
} from '@pertexo/workflow-model';

type Delivery = Extract<
  QueueDelivery,
  { readonly name: 'deliver-run-failure-notification' }
>;

export interface FailureNotificationDeliveryCapability {
  deliver(
    input: Readonly<{
      context: FailureNotificationContext;
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
  ): Promise<FailureNotificationDeliveryResult>;
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
        const claim = claimSettlement.value;
        if (claim.kind !== 'ready' || controller.signal.aborted) return;
        const timeout = setTimeout(() => {
          controller.abort(new Error('failure notification delivery timeout'));
        }, dependencies.timeoutMillis);
        let result: FailureNotificationDeliveryResult;
        try {
          const deliveryPromise = dependencies.delivery.deliver({
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
          });
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
          result = settlement.value;
        } catch {
          result = {
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
      } finally {
        queueContext.signal.removeEventListener('abort', onQueueAbort);
      }
    },
  });
}

type DeliverySettlement<T> =
  Readonly<{ kind: 'fulfilled'; value: T }> | Readonly<{ kind: 'aborted' }>;

function settleUntilAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<DeliverySettlement<T>> {
  const aborted = Symbol('aborted');
  const cancellation = Promise.withResolvers<typeof aborted>();
  const onAbort = (): void => {
    // Let abort-cooperating work settle before detaching an operation that
    // ignores cancellation. Promise.race continues observing late rejection.
    queueMicrotask(() => {
      cancellation.resolve(aborted);
    });
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return Promise.race([operation, cancellation.promise])
    .then((value): DeliverySettlement<T> =>
      value === aborted ? { kind: 'aborted' } : { kind: 'fulfilled', value },
    )
    .finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
}
