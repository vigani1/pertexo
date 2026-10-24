import { useRef, useState } from 'react';
import type { ArtifactMetadataResponse } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { useLatestRequest } from '@/lib/hooks/use-latest-request';
import { beginUpload, finalizeUpload, transferFile } from '../data/upload.api';
import { getArtifactMetadata } from '../data/artifacts.api';
import {
  UploadValidationError,
  describeUpload,
  fileReference,
  uploadFailure,
  type FileReference,
  type UploadMetadata,
  type UploadPhase,
} from '../model/upload';

interface Intent {
  file: File;
  metadata: UploadMetadata;
  key: string;
  artifactId?: string;
}
type UploadState = Readonly<{
  phase: UploadPhase;
  filename?: string;
  byteLength?: number;
  error?: string | undefined;
  reference?: FileReference;
}>;

/** File and signed capabilities live only as long as this local upload session. */
export function useUpload(apiClient: ApiClient, workspaceId: string) {
  const intent = useRef<Intent | undefined>(undefined);
  const requests = useLatestRequest();
  const [state, setState] = useState<UploadState>({ phase: 'empty' });

  async function run(selected?: File) {
    if (requests.pending) return;
    const request = requests.begin();
    const show = (phase: UploadPhase) => {
      if (request.isCurrent())
        setState((current) => ({ ...current, phase, error: undefined }));
    };
    try {
      if (selected !== undefined) {
        intent.current = undefined;
        setState({
          phase: 'hashing',
          filename: selected.name,
          byteLength: selected.size,
        });
        const metadata = await describeUpload(selected, request.signal);
        if (!request.isCurrent()) return;
        intent.current = { file: selected, metadata, key: crypto.randomUUID() };
      }
      const current = intent.current;
      if (current === undefined) return;
      const pendingIntent = current;
      const expected = current.metadata;
      function ready(metadata: ArtifactMetadataResponse) {
        if (!request.isCurrent()) return;
        const artifactMetadataMismatch =
          metadata.id !== pendingIntent.artifactId ||
          metadata.status !== 'available' ||
          metadata.workspaceId !== workspaceId ||
          metadata.byteLength !== expected.byteLength ||
          metadata.mediaType !== expected.mediaType ||
          metadata.sha256 !== expected.sha256;
        if (artifactMetadataMismatch)
          throw new UploadValidationError(
            'The finalized file did not match the selected file. Choose it again.',
          );
        intent.current = undefined;
        setState((previous) => ({
          ...previous,
          phase: 'available',
          error: undefined,
          reference: fileReference(metadata),
        }));
      }
      if (current.artifactId !== undefined) {
        show('finalizing');
        const known = await getArtifactMetadata(
          apiClient,
          workspaceId,
          current.artifactId,
          request.signal,
        );
        if (known.status === 'available') {
          ready(known);
          return;
        }
        if (
          known.expiresAt !== null &&
          Date.parse(known.expiresAt) <= Date.now()
        ) {
          intent.current = undefined;
          throw new UploadValidationError(
            'This upload expired. Choose the file again to start a fresh upload.',
          );
        }
        try {
          const finalized = await finalizeUpload(
            apiClient,
            workspaceId,
            current.artifactId,
            request.signal,
          );
          ready(finalized);
          return;
        } catch (error) {
          if (!isApiError(error) || error.problem?.code !== 'artifact.conflict')
            throw error;
        }
      }
      show('reserving');
      const reservation = await beginUpload({
        apiClient,
        workspaceId,
        metadata: current.metadata,
        key: current.key,
        signal: request.signal,
      });
      if (!request.isCurrent()) return;
      current.artifactId = reservation.artifact.id;
      show('uploading');
      await transferFile(current.file, reservation.upload, request.signal);
      show('finalizing');
      const finalized = await finalizeUpload(
        apiClient,
        workspaceId,
        current.artifactId,
        request.signal,
      );
      ready(finalized);
    } catch (error) {
      if (request.isCurrent())
        setState((previous) => ({
          ...previous,
          phase: 'uncertain',
          error: uploadFailure(error),
        }));
    } finally {
      request.finish();
    }
  }
  return {
    state,
    pending: requests.pending,
    canRetry: intent.current !== undefined,
    select: (file: File) => run(file),
    retry: () => run(),
    cancel: () => {
      requests.abort();
      intent.current = undefined;
      setState({ phase: 'empty' });
    },
  };
}
