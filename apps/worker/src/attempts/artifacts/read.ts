import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  type ArtifactStore,
} from '@pertexo/artifact-store';
import { ARTIFACT_INPUT_MAX_BYTES } from '@pertexo/node-sdk';
import { ArtifactMetadataNotFoundError } from '@pertexo/database/runs';
import {
  FileInputFailure,
  NodeExecutorFailure,
  type NodeArtifactRuntime,
} from '@pertexo/node-sdk/server';

type ReadInput = Parameters<NonNullable<NodeArtifactRuntime['read']>>[0];

export function createArtifactReader(
  input: Readonly<{
    workspaceId: string;
    store: Pick<ArtifactStore, 'getStream'>;
    requireReadable(
      reference: ReadInput['reference'],
      signal: AbortSignal,
    ): Promise<void>;
  }>,
): NonNullable<NodeArtifactRuntime['read']> {
  return async ({ reference, maxBytes, signal }) => {
    let bytes: Uint8Array | undefined;
    try {
      signal.throwIfAborted();
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > ARTIFACT_INPUT_MAX_BYTES ||
        reference.byteLength > maxBytes
      )
        throw new ArtifactIntegrityError(
          'Artifact request body exceeds its byte limit',
        );
      await input.requireReadable(reference, signal);
      const download = await input.store.getStream({
        workspaceId: input.workspaceId,
        artifactId: reference.artifactId,
        signal,
      });
      try {
        const actual = download.metadata;
        if (
          actual.workspaceId !== input.workspaceId ||
          actual.artifactId !== reference.artifactId ||
          actual.byteLength !== reference.byteLength ||
          actual.mediaType !== reference.mediaType ||
          actual.sha256 !== reference.sha256
        )
          throw new ArtifactIntegrityError(
            'Artifact request body metadata changed',
          );
        bytes = new Uint8Array(reference.byteLength);
        let offset = 0;
        for await (const value of download.body) {
          const chunk: unknown = value;
          if (!(chunk instanceof Uint8Array))
            throw new ArtifactIntegrityError(
              'Artifact request body is not bytes',
            );
          try {
            signal.throwIfAborted();
            if (offset + chunk.byteLength > bytes.byteLength)
              throw new ArtifactIntegrityError(
                'Artifact request body exceeds its declared size',
              );
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          } finally {
            chunk.fill(0);
          }
        }
        signal.throwIfAborted();
        if (offset !== bytes.byteLength)
          throw new ArtifactIntegrityError(
            'Artifact request body is incomplete',
          );
        return bytes;
      } finally {
        download.body.destroy();
      }
    } catch (error) {
      bytes?.fill(0);
      if (signal.aborted)
        throw new NodeExecutorFailure({
          kind: 'canceled',
          errorKind: 'canceled',
          possiblyDispatched: false,
        });
      if (
        error instanceof ArtifactMetadataNotFoundError ||
        error instanceof ArtifactNotFoundError
      )
        throw new FileInputFailure({ reason: 'file_unavailable' });
      if (error instanceof ArtifactIntegrityError)
        throw new FileInputFailure({ reason: 'file_integrity' });
      throw new NodeExecutorFailure({
        kind: 'retry',
        errorKind: 'network',
        possiblyDispatched: false,
      });
    }
  };
}
