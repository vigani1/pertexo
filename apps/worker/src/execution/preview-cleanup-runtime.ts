import type { ArtifactStore } from '@pertexo/artifact-store';
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
import {
  InvalidQueueDeliveryError,
  jobIdForOutboxEvent,
  unrecoverableQueueError,
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
      artifactQuiescenceSeconds?: number;
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
      artifactQuiescenceSeconds?: number;
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
  artifacts: Pick<ArtifactStore, 'delete' | 'head'>,
  artifactLimit = 25,
  artifactQuiescenceSeconds = 60,
): PreviewCleanupHandler {
  if (
    !Number.isSafeInteger(artifactLimit) ||
    artifactLimit < 1 ||
    artifactLimit > 100
  )
    throw new TypeError('Preview cleanup artifact limit is invalid');
  if (
    !Number.isSafeInteger(artifactQuiescenceSeconds) ||
    artifactQuiescenceSeconds < 1 ||
    artifactQuiescenceSeconds > 120
  )
    throw new TypeError('Preview cleanup quiescence is invalid');
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
        artifactQuiescenceSeconds,
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
        const remaining = await artifacts.head({
          artifactId: artifact.artifactId,
          signal: context.signal,
          workspaceId: artifact.workspaceId,
        });
        if (remaining !== null)
          return store.finish({
            artifactQuiescenceSeconds,
            delivery: durableDelivery,
            previewRunId: delivery.data.previewRunId,
            signal: context.signal,
            workspaceId: delivery.data.workspaceId,
          });
        await store.completeArtifact({
          artifactId: artifact.artifactId,
          previewRunId: delivery.data.previewRunId,
          signal: context.signal,
          workspaceId: artifact.workspaceId,
        });
      }
      return store.finish({
        artifactQuiescenceSeconds,
        delivery: durableDelivery,
        previewRunId: delivery.data.previewRunId,
        signal: context.signal,
        workspaceId: delivery.data.workspaceId,
      });
    },
  });
}

export function mapPreviewCleanupError(error: unknown): unknown {
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
