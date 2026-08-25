import {
  canonicalOutboxPayloadChecksum,
  WorkflowTriggerReconciliationMismatchError,
  WorkflowTriggerStalePublicationError,
  type PublishedWorkflowReader,
  type WorkflowTriggerReconciliationDatabase,
} from '@pertexo/database';
import {
  InvalidQueueDeliveryError,
  jobIdForOutboxEvent,
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
    reader: PublishedWorkflowReader;
    reconciliation: WorkflowTriggerReconciliationDatabase;
  }>,
): TriggerReconciliationHandler {
  return Object.freeze({
    handle: async (
      delivery: TriggerReconciliationDelivery,
      context: QueueHandlerContext,
    ) => {
      if (
        delivery.transport.jobId !==
        jobIdForOutboxEvent(delivery.data.outboxEventId)
      )
        throw new InvalidQueueDeliveryError(
          'Trigger reconciliation transport identity is invalid',
        );

      const publication = await dependencies.reader.readForExecution({
        workspaceId: delivery.data.workspaceId,
        workflowVersionId: delivery.data.publishedVersionId,
        signal: context.signal,
      });
      if (
        publication.kind !== 'not_found' &&
        (publication.workflowVersion.id !== delivery.data.publishedVersionId ||
          publication.workflowVersion.workflowId !== delivery.data.workflowId ||
          publication.workflowVersion.workspaceId !== delivery.data.workspaceId)
      )
        throw unrecoverableQueueError(
          'Trigger reconciliation publication identity is invalid',
        );

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
