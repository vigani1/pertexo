import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  type ArtifactStore,
} from '@pertexo/artifact-store';
import { ARTIFACT_INPUT_MAX_BYTES, FILE_PAGE_LIMITS } from '@pertexo/node-sdk';
import { ArtifactMetadataNotFoundError } from '@pertexo/core/artifacts';
import {
  FileInputFailure,
  NodeExecutorFailure,
  type NodeArtifactRuntime,
  type NodeVerifiedByteSource,
} from '@pertexo/node-sdk/server';
import type { ArtifactScratchSpace } from './scratch/space.js';
import {
  ArtifactTransfer,
  withByteProgress,
  closeArtifactStream,
} from './scratch/progress.js';
type OpenInput = Parameters<
  NonNullable<NodeArtifactRuntime['openVerified']>
>[0];
export function createArtifactReader(
  input: Readonly<{
    workspaceId: string;
    attemptId: string;
    scratch: ArtifactScratchSpace;
    maximumBytes: number;
    deadlineAt?: Date;
    assertOpen(): void;
    store: Pick<ArtifactStore, 'getStream'>;
    requireReadable(
      reference: OpenInput['reference'],
      signal: AbortSignal,
    ): Promise<void>;
  }>,
): Pick<NodeArtifactRuntime, 'read' | 'openVerified'> {
  const openVerified = async ({
    reference,
    maxBytes,
    signal,
  }: OpenInput): Promise<NodeVerifiedByteSource> => {
    const transfer = new ArtifactTransfer(signal, input.deadlineAt);
    try {
      input.assertOpen();
      signal.throwIfAborted();
      const fileExceedsReadBudget =
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > FILE_PAGE_LIMITS.fileBytes ||
        reference.byteLength > Math.min(maxBytes, input.maximumBytes);
      if (fileExceedsReadBudget)
        throw new FileInputFailure({ reason: 'file_size' });
      await input.requireReadable(reference, transfer.signal);
      const download = await input.store.getStream({
        workspaceId: input.workspaceId,
        artifactId: reference.artifactId,
        signal: transfer.signal,
      });
      download.body.on('error', () => undefined);
      transfer.ownSource((reason) => {
        download.body.destroy(reason);
      });
      try {
        const actual = download.metadata;
        const fileMetadataMismatch =
          actual.workspaceId !== input.workspaceId ||
          actual.artifactId !== reference.artifactId ||
          actual.byteLength !== reference.byteLength ||
          actual.mediaType !== reference.mediaType ||
          actual.sha256 !== reference.sha256;
        if (fileMetadataMismatch)
          throw new ArtifactIntegrityError('Artifact metadata changed');
        const handle = await input.scratch.spool({
          attemptId: input.attemptId,
          body: checkedBody(download, { reference, transfer }),
          maxBytes: Math.max(1, reference.byteLength),
          signal: transfer.signal,
          transfer,
        });
        if (
          handle.byteLength !== reference.byteLength ||
          handle.sha256 !== reference.sha256
        ) {
          await handle.release();
          throw new ArtifactIntegrityError('Artifact integrity mismatch');
        }
        return Object.freeze({
          byteLength: handle.byteLength,
          sha256: handle.sha256,
          release: () => handle.release(),
          open: (readSignal: AbortSignal) => {
            readSignal.throwIfAborted();
            return withByteProgress(
              handle.open(),
              readSignal,
              input.deadlineAt,
            );
          },
        });
      } finally {
        await closeArtifactStream(download.body);
      }
    } catch (error) {
      if (signal.aborted)
        throw new NodeExecutorFailure({
          kind: 'canceled',
          errorKind: 'canceled',
          possiblyDispatched: false,
        });
      if (
        error instanceof FileInputFailure ||
        error instanceof NodeExecutorFailure
      )
        throw error;
      if (
        error instanceof ArtifactMetadataNotFoundError ||
        error instanceof ArtifactNotFoundError
      )
        throw new FileInputFailure({ reason: 'file_unavailable' });
      if (error instanceof ArtifactIntegrityError)
        throw new FileInputFailure({ reason: 'file_integrity' });
      if (transfer.signal.aborted) throw transfer.signal.reason;
      throw new NodeExecutorFailure({
        kind: 'retry',
        errorKind: 'network',
        possiblyDispatched: false,
      });
    } finally {
      transfer.finish();
    }
  };
  return {
    openVerified,
    read: async ({ reference, maxBytes, signal }) => {
      if (
        maxBytes > ARTIFACT_INPUT_MAX_BYTES ||
        reference.byteLength > ARTIFACT_INPUT_MAX_BYTES
      )
        throw new FileInputFailure({ reason: 'file_size' });
      const source = await openVerified({ reference, maxBytes, signal });
      const bytes = new Uint8Array(source.byteLength);
      try {
        let offset = 0;
        for await (const value of source.open(signal)) {
          const chunk: unknown = value;
          if (!(chunk instanceof Uint8Array))
            throw new FileInputFailure({ reason: 'file_integrity' });
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
          chunk.fill(0);
        }
        return bytes;
      } catch (error) {
        bytes.fill(0);
        throw error;
      } finally {
        await source.release();
      }
    },
  };
}

async function* checkedBody(
  download: Awaited<ReturnType<ArtifactStore['getStream']>>,
  {
    reference,
    transfer,
  }: Readonly<{
    reference: OpenInput['reference'];
    transfer: ArtifactTransfer;
  }>,
) {
  let count = 0;
  try {
    for await (const value of download.body) {
      const chunk: unknown = value;
      if (!(chunk instanceof Uint8Array))
        throw new ArtifactIntegrityError('Artifact is not bytes');
      transfer.advance();
      count += chunk.byteLength;
      if (count > reference.byteLength) {
        chunk.fill(0);
        throw new ArtifactIntegrityError('Artifact length mismatch');
      }
      yield chunk;
    }
    if (count !== reference.byteLength)
      throw new ArtifactIntegrityError('Artifact length mismatch');
  } catch (error) {
    if (error instanceof ArtifactIntegrityError)
      throw new FileInputFailure({ reason: 'file_integrity' });
    throw error;
  }
}
