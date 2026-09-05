import {
  canonicalOutboxPayloadChecksum,
  createWorkspaceDatabase,
  InboxChecksumMismatchError,
  InboxReceiptUnavailableError,
  reconcileUnknownOutcomeEvidence,
  type DatabaseConfig,
  type DatabaseRuntime,
  type UnknownOutcomeReconciliationResult,
  UnknownOutcomeReconciliationMismatchError,
  UnknownOutcomeReconciliationStateError,
} from '@pertexo/database/execution';
import {
  unrecoverableQueueError,
  type QueueDelivery,
  type QueueHandlerContext,
} from '@pertexo/queue';

type UnknownOutcomeDelivery = Extract<
  QueueDelivery,
  { readonly name: 'reconcile-unknown-outcome' }
>;

export interface UnknownOutcomeReconciliationStore {
  reconcile(
    input: Readonly<{
      attemptId: string;
      delivery: Readonly<{
        outboxEventId: string;
        payloadChecksum: string;
      }>;
      evidenceCommandId: string;
      signal?: AbortSignal;
      workspaceId: string;
    }>,
  ): Promise<UnknownOutcomeReconciliationResult>;
}

export function createDatabaseUnknownOutcomeReconciliationStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): UnknownOutcomeReconciliationStore & { close(): Promise<void> } {
  const database = createWorkspaceDatabase(
    config,
    runtime === undefined ? {} : { runtime },
  );
  return Object.freeze({
    reconcile: (
      input: Parameters<UnknownOutcomeReconciliationStore['reconcile']>[0],
    ) => reconcileUnknownOutcomeEvidence(database, input),
    close: () => database.close(),
  });
}

export function createUnknownOutcomeReconciliationHandler(
  store: UnknownOutcomeReconciliationStore,
): Readonly<{
  handle(
    delivery: UnknownOutcomeDelivery,
    context: QueueHandlerContext,
  ): Promise<UnknownOutcomeReconciliationResult>;
}> {
  return Object.freeze({
    handle: async (delivery, context) => {
      return store.reconcile({
        attemptId: delivery.data.attemptId,
        delivery: {
          outboxEventId: delivery.data.outboxEventId,
          payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
        },
        evidenceCommandId: delivery.data.evidenceCommandId,
        signal: context.signal,
        workspaceId: delivery.data.workspaceId,
      });
    },
  });
}

export function mapUnknownOutcomeReconciliationError(error: unknown): unknown {
  if (
    error instanceof UnknownOutcomeReconciliationMismatchError ||
    error instanceof UnknownOutcomeReconciliationStateError ||
    error instanceof InboxChecksumMismatchError ||
    error instanceof InboxReceiptUnavailableError
  )
    return unrecoverableQueueError(
      'Unknown-outcome reconciliation failed durable state verification',
    );
  return error;
}
