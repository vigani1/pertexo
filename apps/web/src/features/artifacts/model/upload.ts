import {
  artifactUploadRequestSchema,
  type ArtifactMetadataResponse,
} from '@pertexo/contracts';
import { isApiError } from '@/lib/api/error';
import { describeCommandError } from '@/lib/api/error-copy';

export class UploadValidationError extends Error {}

const MAX_INPUT_FILE_BYTES = 1024 * 1024;
export type UploadMetadata = Pick<
  ArtifactMetadataResponse,
  'byteLength' | 'mediaType' | 'sha256'
>;
export type FileReference = UploadMetadata &
  Readonly<{ kind: 'artifact'; artifactId: string }>;
export type UploadPhase =
  | 'empty'
  | 'hashing'
  | 'reserving'
  | 'uploading'
  | 'finalizing'
  | 'available'
  | 'uncertain';

export function fileReference(
  metadata: ArtifactMetadataResponse,
): FileReference {
  return {
    kind: 'artifact',
    artifactId: metadata.id,
    byteLength: metadata.byteLength,
    mediaType: metadata.mediaType,
    sha256: metadata.sha256,
  };
}

export async function describeUpload(
  file: File,
  signal: AbortSignal,
): Promise<UploadMetadata> {
  if (file.size > MAX_INPUT_FILE_BYTES)
    throw new UploadValidationError(
      'Choose a file no larger than 1 MB. Split larger files into smaller files and upload them separately.',
    );
  signal.throwIfAborted();
  const bytes = await file.arrayBuffer();
  try {
    signal.throwIfAborted();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    signal.throwIfAborted();
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const result = artifactUploadRequestSchema.safeParse({
      byteLength: file.size,
      mediaType: file.type || 'application/octet-stream',
      sha256,
    });
    if (!result.success)
      throw new UploadValidationError(
        'This file has an unsupported media type. Choose another file.',
      );
    return result.data;
  } finally {
    new Uint8Array(bytes).fill(0);
  }
}

export function uploadFailure(error: unknown): string {
  if (isApiError(error)) {
    if (error.problem?.code === 'artifact.unavailable')
      return 'File storage is unavailable. The server needs working ARTIFACT_STORE_* configuration; ask the person running Pertexo to check it.';
    if (error.problem?.code === 'workspace.quota_exceeded')
      return 'The workspace has no storage capacity for this file. Free space or increase its limit, then retry.';
    if (error.problem?.code === 'artifact.conflict')
      return 'The file could not be finalized. Its upload may have expired or its bytes may differ. Choose the file again to start a fresh upload.';
    return describeCommandError(error, 'uploading this file');
  }
  // Browser/storage exception text can contain capabilities; show only our validation copy.
  return error instanceof UploadValidationError
    ? error.message
    : 'The upload could not be confirmed. Check and retry the same file.';
}
