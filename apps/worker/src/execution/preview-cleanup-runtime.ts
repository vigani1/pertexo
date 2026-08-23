import {
  createArtifactStore,
  type ArtifactStore,
  type ArtifactStoreConfig,
} from '@pertexo/artifact-store';
import {
  canonicalOutboxPayloadChecksum,
  claimPreviewCleanupDelivery,
  completePreviewArtifactDeletion,
  finishPreviewCleanupDelivery,
  type DatabaseConfig,
  type PreviewCleanupClaimResult,
  type PreviewCleanupFinishResult,
  PreviewCleanupStateError,
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

type PreviewCleanupDelivery = Extract<
  QueueDelivery,
  { readonly name: 'sweep-expired-previews' }
>;

export interface PreviewCleanupStore {
  claim(
    input: Readonly<{
      artifactLimit: number;
      delivery: Readonly<{
        outboxEventId: string;
        payloadChecksum: string;
      }>;
      previewRunId: string;
      signal?: AbortSignal;
      workspaceId: string;
    }>,
  ): Promise<PreviewCleanupClaimResult>;
  completeArtifact(
    input: Readonly<{
      artifactId: string;
      previewRunId: string;
      signal?: AbortSignal;
      workspaceId: string;
    }>,
  ): Promise<void>;
  finish(
    input: Readonly<{
      delivery: Readonly<{
        outboxEventId: string;
        payloadChecksum: string;
      }>;
      previewRunId: string;
      signal?: AbortSignal;
      workspaceId: string;
    }>,
  ): Promise<PreviewCleanupFinishResult>;
}

export type PreviewCleanupHandlerResult =
  PreviewCleanupClaimResult | PreviewCleanupFinishResult;

export interface PreviewCleanupHandler {
  handle(
    delivery: PreviewCleanupDelivery,
    context: QueueHandlerContext,
  ): Promise<PreviewCleanupHandlerResult>;
}

export interface PreviewCleanupRuntime {
  readonly consumer: QueueConsumer;
  close(): Promise<void>;
}

export function createDatabasePreviewCleanupStore(
  config: DatabaseConfig,
): PreviewCleanupStore & { close(): Promise<void> } {
  const pool = new Pool(config);
  return Object.freeze({
    claim: (input: Parameters<PreviewCleanupStore['claim']>[0]) =>
      claimPreviewCleanupDelivery(pool, input),
    completeArtifact: (
      input: Parameters<PreviewCleanupStore['completeArtifact']>[0],
    ) => completePreviewArtifactDeletion(pool, input),
    finish: (input: Parameters<PreviewCleanupStore['finish']>[0]) =>
      finishPreviewCleanupDelivery(pool, input),
    close: async (): Promise<void> => {
      await pool.end();
    },
  });
}

export function createPreviewCleanupHandler(
  store: PreviewCleanupStore,
  artifacts: Pick<ArtifactStore, 'delete'>,
  artifactLimit = 25,
): PreviewCleanupHandler {
  if (
    !Number.isSafeInteger(artifactLimit) ||
    artifactLimit < 1 ||
    artifactLimit > 100
  )
    throw new TypeError('Preview cleanup artifact limit is invalid');
  return Object.freeze({
    handle: async (
      delivery: PreviewCleanupDelivery,
      context: QueueHandlerContext,
    ): Promise<PreviewCleanupHandlerResult> => {
      if (
        delivery.transport.jobId !==
        jobIdForOutboxEvent(delivery.data.outboxEventId)
      )
        throw new InvalidQueueDeliveryError(
          'Preview cleanup transport identity is invalid',
        );
      const durableDelivery = {
        outboxEventId: delivery.data.outboxEventId,
        payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
      };
      const claimed = await store.claim({
        artifactLimit,
        delivery: durableDelivery,
        previewRunId: delivery.data.previewRunId,
        signal: context.signal,
        workspaceId: delivery.data.workspaceId,
      });
      if (claimed.kind !== 'claimed') return claimed;
      for (const artifact of claimed.artifacts) {
        await artifacts.delete({
          artifactId: artifact.artifactId,
          signal: context.signal,
          workspaceId: artifact.workspaceId,
        });
        await store.completeArtifact({
          artifactId: artifact.artifactId,
          previewRunId: delivery.data.previewRunId,
          signal: context.signal,
          workspaceId: artifact.workspaceId,
        });
      }
      return store.finish({
        delivery: durableDelivery,
        previewRunId: delivery.data.previewRunId,
        signal: context.signal,
        workspaceId: delivery.data.workspaceId,
      });
    },
  });
}

function mapCleanupError(error: unknown): unknown {
  if (
    error instanceof PreviewDeliveryMismatchError ||
    error instanceof PreviewCleanupStateError
  )
    return unrecoverableQueueError(
      error instanceof PreviewDeliveryMismatchError
        ? 'Preview cleanup delivery failed durable state verification'
        : `Preview cleanup is not recoverable: ${error.code}`,
    );
  return error;
}

export async function createPreviewCleanupRuntime(
  options: Readonly<{
    artifactStore: ArtifactStoreConfig;
    database: DatabaseConfig;
    observer?: QueueConsumerObserver;
    redisUrl: string;
  }>,
  dependencies: Readonly<{
    artifactStore?: Pick<ArtifactStore, 'delete'> & { close?: () => void };
    consumerFactory?: typeof createQueueConsumer;
    store?: PreviewCleanupStore & { close?: () => Promise<void> };
  }> = {},
): Promise<PreviewCleanupRuntime> {
  const store =
    dependencies.store ?? createDatabasePreviewCleanupStore(options.database);
  const artifacts =
    dependencies.artifactStore ?? createArtifactStore(options.artifactStore);
  const handler = createPreviewCleanupHandler(store, artifacts);
  let consumer: QueueConsumer;
  try {
    consumer = (dependencies.consumerFactory ?? createQueueConsumer)({
      queueName: QUEUE_NAME.maintenance,
      redisUrl: options.redisUrl,
      handler: async (delivery, context): Promise<void> => {
        if (delivery.name !== JOB_NAME.sweepExpiredPreviews)
          throw new InvalidQueueDeliveryError(
            `Preview cleaner cannot handle ${delivery.name}`,
          );
        try {
          await handler.handle(delivery, context);
        } catch (error: unknown) {
          throw mapCleanupError(error);
        }
      },
      ...(options.observer === undefined ? {} : { observer: options.observer }),
      traceRunner: createQueueTraceRunner(),
    });
  } catch (error: unknown) {
    await store.close?.();
    artifacts.close?.();
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
          Promise.resolve(artifacts.close?.()),
        ]);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      })();
      return closePromise;
    },
  });
}
