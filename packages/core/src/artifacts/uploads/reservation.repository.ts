import {
  postgresFailure,
  rethrowQueryFailure,
  claimCommand,
  completeCommand,
} from '@pertexo/database/primitives';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { artifacts } from '@pertexo/database/schema';
import { artifactStorageKey } from '../records.repository.js';
import { generatePersistedId } from '@pertexo/database/platform';
import type { ArtifactRecord } from '../contract.js';
import type { ArtifactMetadataIdentity } from '../metadata/contract.js';
import { artifactMetadataMatches } from '../metadata.js';
import {
  ARTIFACT_UPLOAD_PENDING_MS,
  ArtifactQuotaExceededError,
  ArtifactUploadConflictError,
  ArtifactUploadIdempotencyConflictError,
  ArtifactUploadNotFoundError,
} from './input.js';
import type { ArtifactUploadResult } from './contract.js';

/** Who may upload decides the purpose; both share one lifecycle and quota. */
export type ArtifactUploadPurpose = 'user-upload' | 'form-upload';

export type ArtifactUploadReservation = Readonly<{
  workspaceId: string;
  purpose: ArtifactUploadPurpose;
  /** Idempotency scope of the uploader, such as an actor or response session. */
  scope: string;
  idempotencyKey: string;
  requestHash: string;
  metadata: ArtifactMetadataIdentity;
}>;

const storedUploadSchema = z.object({ artifactId: z.uuid() }).strict();

function isCapacityExceeded(error: unknown): boolean {
  const { code, detail } = postgresFailure(error);
  return code === 'P0001' && detail === 'artifact_capacity_exceeded';
}

export async function loadArtifact(
  client: PoolClient,
  workspaceId: string,
  artifactId: string,
  statuses: readonly ArtifactRecord['status'][],
): Promise<ArtifactRecord> {
  const [row] = await drizzle(client)
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.workspaceId, workspaceId),
        eq(artifacts.id, artifactId),
        inArray(artifacts.status, [...statuses]),
      ),
    )
    .catch(rethrowQueryFailure);
  if (row === undefined) throw new ArtifactUploadNotFoundError();
  return Object.freeze(row);
}

/**
 * Reserves a pending upload once per idempotency key: the capacity trigger
 * charges its bytes before any signed transfer exists.
 */
export async function reserveArtifactUpload(
  client: PoolClient,
  input: ArtifactUploadReservation,
): Promise<ArtifactUploadResult> {
  const artifactId = generatePersistedId();
  const command = {
    workspaceId: input.workspaceId,
    operation: 'artifact.upload',
    scope: input.scope,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    conflict: () => new ArtifactUploadIdempotencyConflictError(),
  };
  const stored = await claimCommand(client, {
    ...command,
    resourceId: artifactId,
  });
  if (stored !== null) {
    const artifact = await loadArtifact(
      client,
      input.workspaceId,
      storedUploadSchema.parse(stored).artifactId,
      ['pending', 'available'],
    );
    return Object.freeze({ artifact, replayed: true });
  }
  let artifact: ArtifactRecord;
  try {
    const [row] = await drizzle(client)
      .insert(artifacts)
      .values({
        id: artifactId,
        workspaceId: input.workspaceId,
        purpose: input.purpose,
        storageKey: artifactStorageKey(
          input.workspaceId.toLowerCase(),
          artifactId,
        ),
        mediaType: input.metadata.mediaType,
        byteLength: input.metadata.byteLength,
        sha256: input.metadata.sha256,
        status: 'pending',
        expiresAt: sql`clock_timestamp()+make_interval(secs=>${ARTIFACT_UPLOAD_PENDING_MS / 1000})`,
      })
      .returning()
      .catch(rethrowQueryFailure);
    if (row === undefined)
      throw new Error('Artifact upload insert returned no row');
    artifact = Object.freeze(row);
  } catch (error: unknown) {
    if (isCapacityExceeded(error)) throw new ArtifactQuotaExceededError();
    throw error;
  }
  await completeCommand(client, command, { artifactId: artifact.id });
  return Object.freeze({ artifact, replayed: false });
}

/**
 * Makes a verified pending upload available until `retainFor` passes unless
 * something references it. Expired or deleting uploads never come back.
 */
export async function completeArtifactUpload(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    artifactId: string;
    purpose: ArtifactUploadPurpose;
    expectedMetadata: ArtifactMetadataIdentity;
    retainFor: '30 days' | '24 hours' | '1 hour';
  }>,
): Promise<ArtifactRecord> {
  const db = drizzle(client);
  const predicate = and(
    eq(artifacts.workspaceId, input.workspaceId),
    eq(artifacts.id, input.artifactId),
  );
  const [row] = await db
    .select()
    .from(artifacts)
    .where(and(predicate, eq(artifacts.purpose, input.purpose)))
    .for('update')
    .catch(rethrowQueryFailure);
  if (row === undefined) throw new ArtifactUploadNotFoundError();
  if (!artifactMetadataMatches(row, input.expectedMetadata))
    throw new ArtifactUploadConflictError(
      'Artifact upload metadata does not match the declared object',
    );
  if (row.status === 'available') return Object.freeze(row);
  if (row.status !== 'pending')
    throw new ArtifactUploadConflictError('Artifact upload is not pending');
  const [finalized] = await db
    .update(artifacts)
    .set({
      status: 'available',
      finalizedAt: sql`clock_timestamp()`,
      expiresAt: sql`clock_timestamp()+${input.retainFor}::interval`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        predicate,
        eq(artifacts.status, 'pending'),
        sql`${artifacts.expiresAt}>clock_timestamp()`,
      ),
    )
    .returning()
    .catch(rethrowQueryFailure);
  if (finalized === undefined)
    throw new ArtifactUploadConflictError('Artifact upload has expired');
  return Object.freeze(finalized);
}
