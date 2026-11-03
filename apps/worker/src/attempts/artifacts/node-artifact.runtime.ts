import type { ArtifactStore } from '@pertexo/artifact-store';
import { artifactStorageKey } from '@pertexo/core/artifacts';
import { generatePersistedId } from '@pertexo/database/platform';
import type {
  NodeArtifactRuntime,
  NodeVerifiedByteSource,
} from '@pertexo/node-sdk/server';
import type { NodeExecutionCapabilityContext } from '../execution/capabilities.js';
import {
  artifactExpiry,
  assertArtifactByteLimit,
  artifactWriteMetadataSchema,
} from './policy.js';
import { createArtifactReader } from './read.js';
import type { ArtifactScratchSpace } from './scratch/space.js';
import { withByteProgress, closeArtifactStream } from './scratch/progress.js';
export type { ArtifactSpoolOperations } from './scratch/space.js';
type ArtifactDescriptor = Readonly<{
  artifactId: string;
  workspaceId: string;
  byteLength: number;
  mediaType: string;
  sha256: string;
  storageKey: string;
  previewRunId?: string;
}>;
export interface WorkerArtifactPersistence {
  requireReadable?(
    input: NodeExecutionCapabilityContext &
      Readonly<{
        reference: Parameters<
          NonNullable<NodeArtifactRuntime['read']>
        >[0]['reference'];
        signal: AbortSignal;
      }>,
  ): Promise<void>;
  createPending(
    input: ArtifactDescriptor &
      Readonly<{ expiresAt: Date; purpose: string; signal: AbortSignal }>,
  ): Promise<void>;
  finalize(
    input: ArtifactDescriptor & Readonly<{ signal: AbortSignal }>,
  ): Promise<void>;
}
export function createNodeArtifactRuntimeFactory(
  input: Readonly<{
    persistence: WorkerArtifactPersistence;
    store: Pick<ArtifactStore, 'put'> &
      Partial<Pick<ArtifactStore, 'getStream'>>;
    scratch: ArtifactScratchSpace;
    maximumBytes: number;
    assertOpen(): void;
    retentionMillis: number;
    artifactId?: () => string;
    now?: () => Date;
  }>,
): (context: NodeExecutionCapabilityContext) => NodeArtifactRuntime {
  const artifactId = input.artifactId ?? generatePersistedId;
  const now = input.now ?? (() => new Date());
  const requireReadable = input.persistence.requireReadable?.bind(
    input.persistence,
  );
  const getStream = input.store.getStream?.bind(input.store);
  return (context) => {
    const spool: NonNullable<NodeArtifactRuntime['spool']> = async (
      request,
    ) => {
      input.assertOpen();
      request.signal.throwIfAborted();
      assertArtifactByteLimit(request.maxBytes);
      const maximumBytes = Math.min(request.maxBytes, input.maximumBytes);
      const handle = await input.scratch.spool({
        attemptId: context.attemptId,
        body: request.body,
        maxBytes: maximumBytes,
        signal: request.signal,
        ...(context.deadlineAt === undefined
          ? {}
          : { deadlineAt: context.deadlineAt }),
        ...(request.cancelSource === undefined
          ? {}
          : { cancelSource: request.cancelSource }),
      });
      const source: NodeVerifiedByteSource = Object.freeze({
        byteLength: handle.byteLength,
        sha256: handle.sha256,
        release: () => handle.release(),
        open: (signal: AbortSignal) => {
          signal.throwIfAborted();
          return withByteProgress(handle.open(), signal, context.deadlineAt);
        },
      });
      return source;
    };
    return Object.freeze({
      ...(requireReadable === undefined || getStream === undefined
        ? {}
        : createArtifactReader({
            workspaceId: context.workspaceId,
            attemptId: context.attemptId,
            scratch: input.scratch,
            maximumBytes: input.maximumBytes,
            ...(context.deadlineAt === undefined
              ? {}
              : { deadlineAt: context.deadlineAt }),
            assertOpen: input.assertOpen,
            store: { getStream },
            requireReadable: (reference, signal) =>
              requireReadable({ ...context, reference, signal }),
          })),
      spool,
      write: async (request: Parameters<NodeArtifactRuntime['write']>[0]) => {
        const metadata = artifactWriteMetadataSchema.parse(request);
        const handle = await spool(request);
        try {
          request.signal.throwIfAborted();
          const id = artifactId();
          const descriptor: ArtifactDescriptor = Object.freeze({
            artifactId: id,
            workspaceId: context.workspaceId,
            byteLength: handle.byteLength,
            mediaType: metadata.mediaType,
            sha256: handle.sha256,
            storageKey: artifactStorageKey(context.workspaceId, id),
            ...(context.previewRunId === undefined
              ? {}
              : { previewRunId: context.previewRunId }),
          });
          await input.persistence.createPending({
            ...descriptor,
            expiresAt: artifactExpiry(
              now(),
              input.retentionMillis,
              context.artifactRetentionDeadline,
            ),
            purpose: metadata.purpose,
            signal: request.signal,
          });
          request.signal.throwIfAborted();
          const upload = handle.open(request.signal);
          upload.on('error', () => undefined);
          try {
            await input.store.put({
              artifactId: id,
              workspaceId: descriptor.workspaceId,
              byteLength: descriptor.byteLength,
              mediaType: descriptor.mediaType,
              sha256: descriptor.sha256,
              body: upload,
              signal: request.signal,
            });
          } finally {
            await closeArtifactStream(upload);
          }
          request.signal.throwIfAborted();
          await input.persistence.finalize({
            ...descriptor,
            signal: request.signal,
          });
          return Object.freeze({
            artifactId: id,
            byteLength: descriptor.byteLength,
            mediaType: descriptor.mediaType,
            sha256: descriptor.sha256,
          });
        } catch (error) {
          if (error instanceof Error) throw error;
          throw new Error('Artifact operation failed with a non-Error value', {
            cause: undefined,
          });
        } finally {
          await handle.release();
        }
      },
    });
  };
}
