import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
} from '@pertexo/artifact-store';
import {
  ArtifactQuotaExceededError,
  ArtifactUploadConflictError,
  ArtifactUploadIdempotencyConflictError,
  ArtifactUploadNotFoundError,
} from '@pertexo/database/runs';
import { FILE_PAGE_LIMITS } from '@pertexo/node-sdk';
import { AuthorizationError } from '../authorization/index.js';
import {
  ArtifactApiConflictError,
  ArtifactApiNotFoundError,
  ArtifactApiUnavailableError,
  ArtifactUploadDeadlineError,
  ArtifactUploadTooLargeError,
} from './errors.js';
import type { ArtifactRecord } from './ports.js';
import type { ArtifactStore } from './store-port.js';

const MIN_SIGNER_TTL_SECONDS = 60;
const MAX_SIGNER_TTL_SECONDS = 900;

export function assertUploadSize(
  byteLength: number,
  maxObjectBytes: number,
): void {
  if (byteLength > Math.min(FILE_PAGE_LIMITS.fileBytes, maxObjectBytes))
    throw new ArtifactUploadTooLargeError();
}

/** A PUT capability for a pending reservation, never past its own deadline. */
export async function signArtifactUpload(
  store: ArtifactStore,
  artifact: ArtifactRecord,
  now: Date,
  signal?: AbortSignal,
) {
  const remaining = Math.floor(
    (artifact.expiresAt.getTime() - now.getTime()) / 1_000,
  );
  if (remaining < MIN_SIGNER_TTL_SECONDS)
    throw new ArtifactUploadDeadlineError();
  try {
    return await store.beginDirectUpload({
      artifactId: artifact.id,
      byteLength: artifact.byteLength,
      expiresInSeconds: Math.min(MAX_SIGNER_TTL_SECONDS, remaining),
      mediaType: artifact.mediaType,
      sha256: artifact.sha256,
      workspaceId: artifact.workspaceId,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error: unknown) {
    throw storageFailure(error, 'store');
  }
}

/** Checks the stored object's size and fingerprint against its reservation. */
export async function verifyDirectUpload(
  store: ArtifactStore,
  artifact: ArtifactRecord,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await store.validateDirectUpload({
      artifactId: artifact.id,
      byteLength: artifact.byteLength,
      mediaType: artifact.mediaType,
      sha256: artifact.sha256,
      workspaceId: artifact.workspaceId,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error: unknown) {
    throw storageFailure(error, 'store');
  }
}

// Only failures expected from each storage boundary may reach the registry.
export function storageFailure(
  error: unknown,
  source: 'database' | 'store',
): Error {
  // A client that went away is not a storage outage.
  if (error instanceof Error && error.name === 'AbortError') return error;
  if (source === 'store') {
    // Finalization also crosses the database catch, which accepts API errors.
    return error instanceof ArtifactIntegrityError ||
      error instanceof ArtifactNotFoundError
      ? new ArtifactApiConflictError()
      : new ArtifactApiUnavailableError(error);
  }
  if (
    error instanceof AuthorizationError ||
    error instanceof ArtifactApiNotFoundError ||
    error instanceof ArtifactApiConflictError ||
    error instanceof ArtifactApiUnavailableError ||
    error instanceof ArtifactUploadDeadlineError ||
    error instanceof ArtifactQuotaExceededError ||
    error instanceof ArtifactUploadNotFoundError ||
    error instanceof ArtifactUploadIdempotencyConflictError ||
    error instanceof ArtifactUploadConflictError
  )
    return error;
  return new ArtifactApiUnavailableError(error);
}
