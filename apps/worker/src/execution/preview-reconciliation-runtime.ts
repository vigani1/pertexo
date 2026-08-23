import {
  canonicalOutboxPayloadChecksum,
  reconcilePreviewDelivery,
  type DatabaseConfig,
  type PreviewDeliveryReconciliationResult,
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
} from '@pertexo/database';
import { createQueueTraceRunner } from '@pertexo/observability';
import {
  createQueueConsumer,
  InvalidQueueDeliveryError,
  jobIdForOutboxEvent,
  JOB_NAME,
  QUEUE_NAME,
  unrecoverableQueueError,
  type QueueConsumer,
  type QueueConsumerObserver,
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

export interface PreviewReconciliationRuntime {
  readonly consumer: QueueConsumer;
  close(): Promise<void>;
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

function mapReconciliationError(error: unknown): unknown {
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

export async function createPreviewReconciliationRuntime(
  options: Readonly<{
    database: DatabaseConfig;
    observer?: QueueConsumerObserver;
    redisUrl: string;
  }>,
  dependencies: Readonly<{
    consumerFactory?: typeof createQueueConsumer;
    store?: PreviewReconciliationStore & { close?: () => Promise<void> };
  }> = {},
): Promise<PreviewReconciliationRuntime> {
  const store =
    dependencies.store ??
    createDatabasePreviewReconciliationStore(options.database);
  const handler = createPreviewReconciliationHandler(store);
  let consumer: QueueConsumer;
  try {
    consumer = (dependencies.consumerFactory ?? createQueueConsumer)({
      queueName: QUEUE_NAME.maintenance,
      redisUrl: options.redisUrl,
      handler: async (delivery, context): Promise<void> => {
        if (delivery.name !== JOB_NAME.reconcilePreviewAttempt)
          throw new InvalidQueueDeliveryError(
            `Preview reconciler cannot handle ${delivery.name}`,
          );
        try {
          await handler.handle(delivery, context);
        } catch (error: unknown) {
          throw mapReconciliationError(error);
        }
      },
      ...(options.observer === undefined ? {} : { observer: options.observer }),
      traceRunner: createQueueTraceRunner(),
    });
  } catch (error: unknown) {
    await store.close?.();
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    consumer,
    close: (): Promise<void> => {
      closePromise ??= (async (): Promise<void> => {
        const results = await Promise.allSettled([
          consumer.close(),
          store.close?.(),
        ]);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      })();
      return closePromise;
    },
  });
}
