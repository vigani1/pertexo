import { decodeStoredReceipt } from '../../shared/receipts.js';
import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { generatePersistedId } from '@pertexo/database/platform';
import type { ArtifactRecord, ArtifactUploadPurpose } from '../artifact.js';
import type { ArtifactMetadataIdentity } from '../metadata.js';
import { artifactMetadataMatches } from '../metadata.js';
import {
  ArtifactQuotaExceededError,
  ArtifactUploadConflictError,
  ArtifactUploadIdempotencyConflictError,
  ArtifactUploadNotFoundError,
} from './artifact-upload.errors.js';
import type { ArtifactUploadResult } from './artifact-upload.js';
import {
  insertPendingUpload,
  lockUpload,
  markUploadAvailable,
  readArtifact,
} from './reservation.repository.js';

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

export async function loadArtifact(
  client: PoolClient,
  workspaceId: string,
  artifactId: string,
  statuses: readonly ArtifactRecord['status'][],
): Promise<ArtifactRecord> {
  const row = await readArtifact(client, workspaceId, artifactId, statuses);
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
      decodeStoredReceipt(storedUploadSchema, stored).artifactId,
      ['pending', 'available'],
    );
    return Object.freeze({ artifact, replayed: true });
  }
  const inserted = await insertPendingUpload(client, {
    artifactId,
    workspaceId: input.workspaceId,
    purpose: input.purpose,
    metadata: input.metadata,
  });
  if (inserted.kind === 'capacity_exceeded')
    throw new ArtifactQuotaExceededError();
  const { artifact } = inserted;
  await completeCommand(client, command, { artifactId: artifact.id });
  return Object.freeze({ artifact, replayed: false });
}

/**
 * Makes a verified pending upload available until `retainForSeconds` pass unless
 * something references it. Expired or deleting uploads never come back.
 */
export async function completeArtifactUpload(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    artifactId: string;
    purpose: ArtifactUploadPurpose;
    expectedMetadata: ArtifactMetadataIdentity;
    retainForSeconds: number;
  }>,
): Promise<ArtifactRecord> {
  const row = await lockUpload(client, input);
  if (row === undefined) throw new ArtifactUploadNotFoundError();
  if (!artifactMetadataMatches(row, input.expectedMetadata))
    throw new ArtifactUploadConflictError(
      'Artifact upload metadata does not match the declared object',
    );
  if (row.status === 'available') return Object.freeze(row);
  if (row.status !== 'pending')
    throw new ArtifactUploadConflictError('Artifact upload is not pending');
  const finalized = await markUploadAvailable(client, input);
  if (finalized === undefined)
    throw new ArtifactUploadConflictError('Artifact upload has expired');
  return Object.freeze(finalized);
}
