import { canonicalOutboxPayloadChecksum } from '@pertexo/database/outbox';
import {
  WorkflowTriggerReconciliationMismatchError,
  WorkflowTriggerStalePublicationError,
  type WorkflowTriggerReconciliationDatabase,
} from '@pertexo/database/triggers';
import {
  unrecoverableQueueError,
  type QueueDelivery,
  type QueueHandlerContext,
} from '@pertexo/queue';

type TriggerReconciliationDelivery = Extract<
  QueueDelivery,
  { readonly name: 'reconcile-workflow-triggers' }
>;

export interface TriggerReconciliationHandler {
  handle(
    delivery: TriggerReconciliationDelivery,
    context: QueueHandlerContext,
  ): Promise<Readonly<{ kind: 'reconciled' | 'stale' }>>;
}

export function createTriggerReconciliationHandler(
  dependencies: Readonly<{
    reconciliation: WorkflowTriggerReconciliationDatabase;
  }>,
): TriggerReconciliationHandler {
  return Object.freeze({
    handle: async (
      delivery: TriggerReconciliationDelivery,
      context: QueueHandlerContext,
    ) => {
      // Reconciliation checks the publication itself; a canceled delivery
      // must not open its transaction.
      context.signal.throwIfAborted();

      try {
        await dependencies.reconciliation.reconcile({
          workspaceId: delivery.data.workspaceId,
          workflowId: delivery.data.workflowId,
          publishedVersionId: delivery.data.publishedVersionId,
          outboxEventId: delivery.data.outboxEventId,
          delivery: {
            outboxEventId: delivery.data.outboxEventId,
            payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
          },
        });
        return Object.freeze({ kind: 'reconciled' as const });
      } catch (error: unknown) {
        if (error instanceof WorkflowTriggerStalePublicationError)
          return Object.freeze({ kind: 'stale' as const });
        if (error instanceof WorkflowTriggerReconciliationMismatchError)
          throw unrecoverableQueueError(
            'Trigger reconciliation delivery failed durable state verification',
          );
        try {
          await dependencies.reconciliation.recordFailure({
            workspaceId: delivery.data.workspaceId,
            workflowId: delivery.data.workflowId,
            publishedVersionId: delivery.data.publishedVersionId,
            reason: 'trigger.reconciliation_failed',
          });
        } catch {
          // Preserve the retryable cause when PostgreSQL cannot record health.
        }
        throw error;
      }
    },
  });
}
