import {
  createArtifactStore,
  type ArtifactStore,
  type ArtifactStoreConfig,
} from '@pertexo/artifact-store';
import type { DatabaseConfig } from '@pertexo/database';
import { createQueueTraceRunner } from '@pertexo/observability';
import {
  createQueueConsumer,
  InvalidQueueDeliveryError,
  JOB_NAME,
  QUEUE_NAME,
  type QueueConsumer,
  type QueueConsumerObserver,
} from '@pertexo/queue';

import {
  createDatabasePreviewCleanupStore,
  createPreviewCleanupHandler,
  mapPreviewCleanupError,
  type PreviewCleanupStore,
} from './preview-cleanup-runtime.js';
import {
  createDatabasePreviewReconciliationStore,
  createPreviewReconciliationHandler,
  mapPreviewReconciliationError,
  type PreviewReconciliationStore,
} from './preview-reconciliation-runtime.js';

export interface PreviewMaintenanceRuntime {
  readonly consumer: QueueConsumer;
  close(): Promise<void>;
}

export async function createPreviewMaintenanceRuntime(
  options: Readonly<{
    artifactStore?: ArtifactStoreConfig;
    database: DatabaseConfig;
    observer?: QueueConsumerObserver;
    redisUrl: string;
  }>,
  dependencies: Readonly<{
    artifactStore?: Pick<
      ArtifactStore,
      'checkReadiness' | 'delete' | 'head'
    > & { close?: () => void };
    cleanupStore?: PreviewCleanupStore & { close?: () => Promise<void> };
    consumerFactory?: typeof createQueueConsumer;
    reconciliationStore?: PreviewReconciliationStore & {
      close?: () => Promise<void>;
    };
  }> = {},
): Promise<PreviewMaintenanceRuntime> {
  const reconciliationStore =
    dependencies.reconciliationStore ??
    createDatabasePreviewReconciliationStore(options.database);
  const hasInjectedCleanupStore = dependencies.cleanupStore !== undefined;
  const hasInjectedArtifactStore = dependencies.artifactStore !== undefined;
  if (
    options.artifactStore === undefined &&
    hasInjectedCleanupStore !== hasInjectedArtifactStore
  )
    throw new TypeError(
      'Preview maintenance cleanup dependencies are incomplete',
    );
  const cleanupEnabled =
    options.artifactStore !== undefined ||
    (hasInjectedCleanupStore && hasInjectedArtifactStore);
  const cleanupStore = !cleanupEnabled
    ? undefined
    : (dependencies.cleanupStore ??
      createDatabasePreviewCleanupStore(options.database));
  const artifacts =
    dependencies.artifactStore ??
    (options.artifactStore === undefined
      ? undefined
      : createArtifactStore(options.artifactStore));
  const artifactQuiescenceSeconds =
    options.artifactStore === undefined
      ? undefined
      : Math.min(
          120,
          Math.ceil(options.artifactStore.requestTimeoutMs / 1_000) + 1,
        );
  const reconciliation =
    createPreviewReconciliationHandler(reconciliationStore);
  const cleanup =
    cleanupStore === undefined || artifacts === undefined
      ? undefined
      : createPreviewCleanupHandler(
          cleanupStore,
          artifacts,
          25,
          artifactQuiescenceSeconds ?? 60,
        );
  let consumer: QueueConsumer;
  try {
    await artifacts?.checkReadiness();
    consumer = (dependencies.consumerFactory ?? createQueueConsumer)({
      queueName: QUEUE_NAME.maintenance,
      redisUrl: options.redisUrl,
      handler: async (delivery, context): Promise<void> => {
        if (delivery.name === JOB_NAME.reconcilePreviewAttempt) {
          try {
            await reconciliation.handle(delivery, context);
          } catch (error: unknown) {
            throw mapPreviewReconciliationError(error);
          }
          return;
        }
        if (delivery.name === JOB_NAME.sweepExpiredPreviews) {
          if (cleanup === undefined)
            throw new InvalidQueueDeliveryError(
              'Preview cleanup is not enabled in this maintenance runtime',
            );
          try {
            await cleanup.handle(delivery, context);
          } catch (error: unknown) {
            throw mapPreviewCleanupError(error);
          }
          return;
        }
        throw new InvalidQueueDeliveryError(
          `Preview maintenance cannot handle ${delivery.name}`,
        );
      },
      ...(options.observer === undefined ? {} : { observer: options.observer }),
      traceRunner: createQueueTraceRunner(),
    });
  } catch (error: unknown) {
    await Promise.allSettled([
      reconciliationStore.close?.(),
      cleanupStore?.close?.(),
      Promise.resolve(artifacts?.close?.()),
    ]);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    consumer,
    close: (): Promise<void> => {
      closePromise ??= (async (): Promise<void> => {
        const results = await Promise.allSettled([
          consumer.close(),
          reconciliationStore.close?.(),
          cleanupStore?.close?.(),
          Promise.resolve(artifacts?.close?.()),
        ]);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      })();
      return closePromise;
    },
  });
}
