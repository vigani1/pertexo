import { FILE_PAGE_LIMITS } from '@pertexo/node-sdk';
import {
  artifactUploadRequestSchema,
  type ArtifactMetadataResponse,
} from '@pertexo/contracts';
import { isApiError } from '@/lib/api/error';
import { describeCommandError } from '@/lib/api/error-copy';

export class UploadValidationError extends Error {}

const MAX_INPUT_FILE_BYTES = FILE_PAGE_LIMITS.fileBytes;
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

/** Hex SHA-256 of a chosen file; its bytes are cleared once hashed. */
export async function digestFile(
  file: File,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const bytes = await file.arrayBuffer();
  try {
    signal.throwIfAborted();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    signal.throwIfAborted();
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  } finally {
    new Uint8Array(bytes).fill(0);
  }
}

export async function describeUpload(
  file: File,
  signal: AbortSignal,
): Promise<UploadMetadata> {
  if (file.size > MAX_INPUT_FILE_BYTES)
    throw new UploadValidationError(
      'Choose a file no larger than 10 MB. Split larger files into smaller files and upload them separately.',
    );
  const result = artifactUploadRequestSchema.safeParse({
    byteLength: file.size,
    mediaType: file.type || 'application/octet-stream',
    sha256: await digestFile(file, signal),
  });
  if (!result.success)
    throw new UploadValidationError(
      'This file has an unsupported media type. Choose another file.',
    );
  return result.data;
}

export function uploadFailure(error: unknown): string {
  if (isApiError(error)) {
    if (error.problem?.code === 'artifact.too_large')
      return 'The file exceeds the server’s storage limit (up to 10 MB). Split it into smaller files and upload them separately.';
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
