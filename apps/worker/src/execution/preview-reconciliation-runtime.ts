import {
  canonicalOutboxPayloadChecksum,
  createDatabasePool,
  reconcilePreviewDelivery,
  type DatabaseConfig,
  type PreviewDeliveryReconciliationResult,
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
} from '@pertexo/database/execution';
import {
  unrecoverableQueueError,
  type QueueDelivery,
  type QueueHandlerContext,
} from '@pertexo/queue';
import {
  createProductionPreviewTelemetry,
  type PreviewTelemetry,
} from './preview-telemetry.js';

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
  const pool = createDatabasePool(config);
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
  telemetry: PreviewTelemetry = createProductionPreviewTelemetry(),
): PreviewReconciliationHandler {
  return Object.freeze({
    handle: async (
      delivery: PreviewReconciliationDelivery,
      context: QueueHandlerContext,
    ): Promise<PreviewDeliveryReconciliationResult> => {
      const result = await store.reconcile({
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
      try {
        telemetry.recordReconciliation({
          decision: result.kind,
          ...(result.kind === 'completed' ? { outcome: result.status } : {}),
        });
        if (result.kind === 'completed')
          telemetry.recordTerminal({
            mayContactProvider: result.mayContactProvider,
            mayCauseExternalSideEffect: result.mayCauseExternalSideEffect,
            ...(result.operationKey === undefined
              ? {}
              : { operationKey: result.operationKey }),
            outcome: result.status,
            possiblyDispatched: result.possiblyDispatched,
            ...(result.providerKey === undefined
              ? {}
              : { providerKey: result.providerKey }),
            sideEffectClass: result.sideEffectClass,
            source: 'reconciliation',
            usesConnection: result.usesConnection,
          });
      } catch {
        // Diagnostics cannot change a committed reconciliation decision.
      }
      return result;
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
