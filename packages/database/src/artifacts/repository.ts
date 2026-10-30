import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { artifactLinks, artifacts, previewRuns } from '../schema.js';
import type { WorkspaceTransaction } from '../tenant-access/transactions.js';
import type {
  ArtifactRecord,
  ClaimDueUnfinalizedArtifactInput,
  ClaimDueUnfinalizedArtifactsInput,
  CompleteArtifactRemovalInput,
  CreatePendingArtifactInput,
  CreatePendingPreviewArtifactInput,
  FinalizeArtifactInput,
} from './contract.js';
import {
  ARTIFACT_STATUS,
  ArtifactFinalizeConflictError,
  ArtifactLifecycleConflictError,
  ArtifactMetadataNotFoundError,
} from './input.js';
import { artifactMetadataMatches } from './metadata/validation.js';
export function artifactStorageKey(
  workspaceId: string,
  artifactId: string,
): string {
  return `workspaces/${workspaceId}/artifacts/${artifactId}`;
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

  const locked = await transaction.db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, input.artifactId))
    .for('update');
  const artifact = locked[0];
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

export async function claimDueUnfinalizedArtifacts(
  transaction: WorkspaceTransaction,
  input: ClaimDueUnfinalizedArtifactsInput,
): Promise<readonly ArtifactRecord[]> {
  const due = await transaction.db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.status, ARTIFACT_STATUS.pending),
        lte(artifacts.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .orderBy(asc(artifacts.expiresAt), asc(artifacts.id))
    .limit(input.limit)
    .for('update', { skipLocked: true });
  if (due.length === 0) return Object.freeze([]);

  // The rows stay locked and pending until this transaction ends.
  const claimed = await transaction.db
    .update(artifacts)
    .set({
      status: ARTIFACT_STATUS.deleting,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      inArray(
        artifacts.id,
        due.map(({ id }) => id),
      ),
    )
    .returning();
  return Object.freeze(claimed);
}

export async function claimDueUnfinalizedArtifact(
  transaction: WorkspaceTransaction,
  input: ClaimDueUnfinalizedArtifactInput,
): Promise<ArtifactRecord> {
  const locked = await transaction.db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, input.artifactId))
    .for('update');
  const artifact = locked[0];
  if (artifact === undefined) throw new ArtifactMetadataNotFoundError();
  if (artifact.status === ARTIFACT_STATUS.deleting) return artifact;
  if (artifact.status !== ARTIFACT_STATUS.pending) {
    throw new ArtifactLifecycleConflictError(
      `Artifact cannot be claimed for unfinalized cleanup from ${artifact.status}`,
    );
  }
  const [expiry] = await transaction.db
    .select({
      expired: sql<boolean | null>`${artifacts.expiresAt}<=clock_timestamp()`,
    })
    .from(artifacts)
    .where(eq(artifacts.id, artifact.id));
  if (!(expiry?.expired ?? false)) {
    throw new ArtifactLifecycleConflictError('Pending artifact is not due');
  }

  const rows = await transaction.db
    .update(artifacts)
    .set({
      status: ARTIFACT_STATUS.deleting,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(artifacts.id, input.artifactId),
        eq(artifacts.status, ARTIFACT_STATUS.pending),
      ),
    )
    .returning();
  const claimed = rows[0];
  if (claimed === undefined) {
    throw new ArtifactLifecycleConflictError('Artifact cleanup lost its lock');
  }
  return claimed;
}

export async function completeArtifactRemoval(
  transaction: WorkspaceTransaction,
  input: CompleteArtifactRemovalInput,
): Promise<ArtifactRecord> {
  const locked = await transaction.db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, input.artifactId))
    .for('update');
  const artifact = locked[0];
  if (artifact === undefined) throw new ArtifactMetadataNotFoundError();
  if (artifact.status === ARTIFACT_STATUS.deleted) return artifact;
  if (artifact.status !== ARTIFACT_STATUS.deleting) {
    throw new ArtifactLifecycleConflictError(
      `Artifact cannot complete removal from ${artifact.status}`,
    );
  }

  const rows = await transaction.db
    .update(artifacts)
    .set({
      deletedAt: sql`clock_timestamp()`,
      status: ARTIFACT_STATUS.deleted,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(artifacts.id, input.artifactId),
        eq(artifacts.status, ARTIFACT_STATUS.deleting),
      ),
    )
    .returning();
  const deleted = rows[0];
  if (deleted === undefined) {
    throw new ArtifactLifecycleConflictError('Artifact removal lost its lock');
  }
  return deleted;
}
