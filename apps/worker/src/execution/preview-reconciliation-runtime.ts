import {
  canonicalOutboxPayloadChecksum,
  reconcilePreviewDelivery,
  type DatabaseConfig,
  type PreviewDeliveryReconciliationResult,
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
} from '@pertexo/database';
import {
  InvalidQueueDeliveryError,
  jobIdForOutboxEvent,
  unrecoverableQueueError,
  type QueueDelivery,
  type QueueHandlerContext,
} from '@pertexo/queue';
import { Pool } from 'pg';

type PreviewReconciliationDelivery = Extract<
  QueueDelivery,
  { readonly name: 'reconcile-preview-attempt' }
>;

export interface PreviewReconciliationStore {
  reconcile(
    input: Readonly<{
      attemptFenceToken: number;
      delivery: Readonly<{
        outboxEventId: string;
        payloadChecksum: string;
      }>;
      previewAttemptId: string;
      previewRunId: string;
      signal?: AbortSignal;
      workspaceId: string;
    }>,
  ): Promise<PreviewDeliveryReconciliationResult>;
}

export interface PreviewReconciliationHandler {
  handle(
    delivery: PreviewReconciliationDelivery,
    context: QueueHandlerContext,
  ): Promise<PreviewDeliveryReconciliationResult>;
}

export function createDatabasePreviewReconciliationStore(
  config: DatabaseConfig,
): PreviewReconciliationStore & { close(): Promise<void> } {
  const pool = new Pool(config);
  return Object.freeze({
    reconcile: (
      input: Parameters<PreviewReconciliationStore['reconcile']>[0],
    ) => reconcilePreviewDelivery(pool, input),
    close: async (): Promise<void> => {
      await pool.end();
    },
  });
}

export function createPreviewReconciliationHandler(
  store: PreviewReconciliationStore,
): PreviewReconciliationHandler {
  return Object.freeze({
    handle: async (
      delivery: PreviewReconciliationDelivery,
      context: QueueHandlerContext,
    ): Promise<PreviewDeliveryReconciliationResult> => {
      if (
        delivery.transport.jobId !==
        jobIdForOutboxEvent(delivery.data.outboxEventId)
      )
        throw new InvalidQueueDeliveryError(
          'Preview reconciliation transport identity is invalid',
        );
      return store.reconcile({
        attemptFenceToken: delivery.data.attemptFenceToken,
        delivery: {
          outboxEventId: delivery.data.outboxEventId,
          payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
        },
        previewAttemptId: delivery.data.previewAttemptId,
        previewRunId: delivery.data.previewRunId,
        signal: context.signal,
        workspaceId: delivery.data.workspaceId,
      });
    },
  });
}

export function mapPreviewReconciliationError(error: unknown): unknown {
  if (
    error instanceof PreviewDeliveryMismatchError ||
    error instanceof PreviewAttemptStateError
  )
    return unrecoverableQueueError(
      error instanceof PreviewDeliveryMismatchError
        ? 'Preview reconciliation delivery failed durable state verification'
        : `Preview reconciliation is not recoverable: ${error.code}`,
    );
  return error;
}
