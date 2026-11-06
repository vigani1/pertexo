import { and, eq, sql } from 'drizzle-orm';
import {
  artifactLinks,
  artifacts,
  previewRuns,
} from '@pertexo/database/schema';
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
import { artifactMetadataMatches } from './metadata.js';
export function artifactStorageKey(
  workspaceId: string,
  artifactId: string,
): string {
  return `workspaces/${workspaceId}/artifacts/${artifactId}`;
}

async function lockArtifact(
  transaction: WorkspaceTransaction,
  artifactId: string,
): Promise<ArtifactRecord> {
  const [artifact] = await transaction.db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, artifactId))
    .for('update');
  if (artifact === undefined) throw new ArtifactMetadataNotFoundError();
  return artifact;
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

  const rows = await transaction.db
    .insert(artifacts)
    .values({
      byteLength: parsed.byteLength,
      expiresAt: parsed.expiresAt,
      id: parsed.artifactId,
      mediaType: parsed.mediaType,
      purpose: parsed.purpose,
      sha256: parsed.sha256,
      status: ARTIFACT_STATUS.pending,
      storageKey: parsed.storageKey,
      workspaceId: transaction.workspaceId,
    })
    .returning();
  const artifact = rows[0];
  if (artifact === undefined) {
    throw new Error('Pending artifact insert returned no row');
  }
  return artifact;
}

/**
 * Creates preview artifact metadata and its immutable owner link in the same
 * tenant transaction, within the owning preview's immutable retention deadline.
 */
export async function createPendingPreviewArtifact(
  transaction: WorkspaceTransaction,
  input: CreatePendingPreviewArtifactInput,
): Promise<ArtifactRecord> {
  const [owner] = await transaction.db
    .select({ expiresAt: previewRuns.expiresAt })
    .from(previewRuns)
    .where(
      and(
        eq(previewRuns.workspaceId, transaction.workspaceId),
        eq(previewRuns.id, input.previewRunId),
      ),
    );
  if (owner === undefined)
    throw new ArtifactLifecycleConflictError(
      'Preview artifact owner is unavailable',
    );
  if (input.expiresAt.getTime() > owner.expiresAt.getTime())
    throw new ArtifactLifecycleConflictError(
      'Preview artifact retention exceeds its owner',
    );
  const artifact = await createPendingArtifact(transaction, input);
  await transaction.db.insert(artifactLinks).values({
    artifactId: artifact.id,
    ownerId: input.previewRunId,
    ownerKind: 'preview_run',
    workspaceId: transaction.workspaceId,
  });
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
  if (!exactMetadataMatches(artifact, input)) {
    throw new ArtifactFinalizeConflictError();
  }
  if (artifact.status === ARTIFACT_STATUS.available) return artifact;
  if (artifact.status !== ARTIFACT_STATUS.pending) {
    throw new ArtifactLifecycleConflictError(
      `Artifact cannot be finalized from ${artifact.status}`,
    );
  }
  const [expiry] = await transaction.db
    .select({
      expired: sql<boolean | null>`${artifacts.expiresAt}<=clock_timestamp()`,
    })
    .from(artifacts)
    .where(eq(artifacts.id, artifact.id));
  if (expiry?.expired !== false) {
    throw new ArtifactLifecycleConflictError('Pending artifact has expired');
  }

  const rows = await transaction.db
    .update(artifacts)
    .set({
      finalizedAt: sql`clock_timestamp()`,
      status: ARTIFACT_STATUS.available,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(artifacts.id, input.artifactId),
        eq(artifacts.status, ARTIFACT_STATUS.pending),
      ),
    )
    .returning();
  const finalized = rows[0];
  if (finalized === undefined) {
    throw new ArtifactLifecycleConflictError('Artifact finalize lost its lock');
  }
  return finalized;
}
