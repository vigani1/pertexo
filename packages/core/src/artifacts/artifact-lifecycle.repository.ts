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
} from './artifact.js';

export function artifactStorageKey(
  workspaceId: string,
  artifactId: string,
): string {
  return `workspaces/${workspaceId}/artifacts/${artifactId}`;
}

export async function lockArtifact(
  transaction: WorkspaceTransaction,
  artifactId: string,
): Promise<ArtifactRecord | undefined> {
  const [artifact] = await transaction.db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, artifactId))
    .for('update');
  return artifact;
}

export async function insertPendingArtifact(
  transaction: WorkspaceTransaction,
  parsed: CreatePendingArtifactInput,
): Promise<ArtifactRecord> {
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

/** The owning preview's retention deadline, or undefined when it's gone. */
export async function readPreviewOwnerExpiry(
  transaction: WorkspaceTransaction,
  previewRunId: string,
): Promise<Date | undefined> {
  const [owner] = await transaction.db
    .select({ expiresAt: previewRuns.expiresAt })
    .from(previewRuns)
    .where(
      and(
        eq(previewRuns.workspaceId, transaction.workspaceId),
        eq(previewRuns.id, previewRunId),
      ),
    );
  return owner?.expiresAt;
}

export async function insertPreviewArtifactLink(
  transaction: WorkspaceTransaction,
  artifactId: string,
  previewRunId: string,
): Promise<void> {
  await transaction.db.insert(artifactLinks).values({
    artifactId,
    ownerId: previewRunId,
    ownerKind: 'preview_run',
    workspaceId: transaction.workspaceId,
  });
}

/** Whether the artifact's expiry has passed; null or missing reads as expired. */
export async function readArtifactExpired(
  transaction: WorkspaceTransaction,
  artifactId: string,
): Promise<boolean> {
  const [expiry] = await transaction.db
    .select({
      expired: sql<boolean | null>`${artifacts.expiresAt}<=clock_timestamp()`,
    })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId));
  return expiry?.expired !== false;
}

export async function markPendingArtifactAvailable(
  transaction: WorkspaceTransaction,
  artifactId: string,
): Promise<ArtifactRecord | undefined> {
  const rows = await transaction.db
    .update(artifacts)
    .set({
      finalizedAt: sql`clock_timestamp()`,
      status: ARTIFACT_STATUS.available,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(artifacts.id, artifactId),
        eq(artifacts.status, ARTIFACT_STATUS.pending),
      ),
    )
    .returning();
  return rows[0];
}
