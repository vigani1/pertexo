import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import {
  ARTIFACT_STATUS,
  type ArtifactRecord,
  type CreatePendingArtifactInput,
  type CreatePendingPreviewArtifactInput,
  type FinalizeArtifactInput,
} from './artifact.js';
import {
  ArtifactFinalizeConflictError,
  ArtifactLifecycleConflictError,
  ArtifactMetadataNotFoundError,
} from './artifact.errors.js';
import {
  artifactStorageKey,
  insertPendingArtifact,
  insertPreviewArtifactLink,
  lockArtifact,
  markPendingArtifactAvailable,
  readArtifactExpired,
  readPreviewOwnerExpiry,
} from './artifact-lifecycle.repository.js';
import { artifactMetadataMatches } from './metadata.js';

export async function createPendingArtifact(
  transaction: WorkspaceTransaction,
  parsed: CreatePendingArtifactInput,
): Promise<ArtifactRecord> {
  if (
    parsed.storageKey !==
    artifactStorageKey(transaction.workspaceId, parsed.artifactId)
  ) {
    throw new ArtifactFinalizeConflictError();
  }
  return insertPendingArtifact(transaction, parsed);
}

/**
 * Creates preview artifact metadata and its immutable owner link in the same
 * tenant transaction, within the owning preview's immutable retention deadline.
 */
export async function createPendingPreviewArtifact(
  transaction: WorkspaceTransaction,
  input: CreatePendingPreviewArtifactInput,
): Promise<ArtifactRecord> {
  const ownerExpiresAt = await readPreviewOwnerExpiry(
    transaction,
    input.previewRunId,
  );
  if (ownerExpiresAt === undefined)
    throw new ArtifactLifecycleConflictError(
      'Preview artifact owner is unavailable',
    );
  if (input.expiresAt.getTime() > ownerExpiresAt.getTime())
    throw new ArtifactLifecycleConflictError(
      'Preview artifact retention exceeds its owner',
    );
  const artifact = await createPendingArtifact(transaction, input);
  await insertPreviewArtifactLink(transaction, artifact.id, input.previewRunId);
  return artifact;
}

export async function finalizeArtifactUpload(
  transaction: WorkspaceTransaction,
  input: FinalizeArtifactInput,
): Promise<ArtifactRecord> {
  if (
    input.workspaceId !== transaction.workspaceId ||
    input.storageKey !== artifactStorageKey(input.workspaceId, input.artifactId)
  ) {
    throw new ArtifactFinalizeConflictError();
  }

  const artifact = await lockArtifact(transaction, input.artifactId);
  if (artifact === undefined) throw new ArtifactMetadataNotFoundError();
  if (!exactMetadataMatches(artifact, input)) {
    throw new ArtifactFinalizeConflictError();
  }
  if (artifact.status === ARTIFACT_STATUS.available) return artifact;
  if (artifact.status !== ARTIFACT_STATUS.pending) {
    throw new ArtifactLifecycleConflictError(
      `Artifact cannot be finalized from ${artifact.status}`,
    );
  }
  if (await readArtifactExpired(transaction, artifact.id)) {
    throw new ArtifactLifecycleConflictError('Pending artifact has expired');
  }

  const finalized = await markPendingArtifactAvailable(
    transaction,
    input.artifactId,
  );
  if (finalized === undefined) {
    throw new ArtifactLifecycleConflictError('Artifact finalize lost its lock');
  }
  return finalized;
}

function exactMetadataMatches(
  artifact: ArtifactRecord,
  validated: FinalizeArtifactInput,
): boolean {
  return (
    artifact.workspaceId === validated.workspaceId &&
    artifact.id === validated.artifactId &&
    artifactMetadataMatches(artifact, validated) &&
    artifact.storageKey === validated.storageKey
  );
}
