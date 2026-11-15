import {
  postgresFailure,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { artifacts } from '@pertexo/database/schema';
import { artifactStorageKey } from '../artifact-lifecycle.repository.js';
import type { ArtifactRecord, ArtifactUploadPurpose } from '../artifact.js';
import type { ArtifactMetadataIdentity } from '../metadata.js';
import { ARTIFACT_UPLOAD_PENDING_MS } from './artifact-upload.js';

export async function readArtifact(
  client: PoolClient,
  workspaceId: string,
  artifactId: string,
  statuses: readonly ArtifactRecord['status'][],
): Promise<ArtifactRecord | undefined> {
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
  return row;
}

/** The capacity trigger refuses the insert when its bytes don't fit. */
export async function insertPendingUpload(
  client: PoolClient,
  input: Readonly<{
    artifactId: string;
    workspaceId: string;
    purpose: ArtifactUploadPurpose;
    metadata: ArtifactMetadataIdentity;
  }>,
): Promise<
  | Readonly<{ kind: 'inserted'; artifact: ArtifactRecord }>
  | Readonly<{ kind: 'capacity_exceeded' }>
> {
  try {
    const [row] = await drizzle(client)
      .insert(artifacts)
      .values({
        id: input.artifactId,
        workspaceId: input.workspaceId,
        purpose: input.purpose,
        storageKey: artifactStorageKey(
          input.workspaceId.toLowerCase(),
          input.artifactId,
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
    return { kind: 'inserted', artifact: Object.freeze(row) };
  } catch (error: unknown) {
    if (isCapacityExceeded(error)) return { kind: 'capacity_exceeded' };
    throw error;
  }
}

type UploadKey = Readonly<{ workspaceId: string; artifactId: string }>;

export async function lockUpload(
  client: PoolClient,
  input: UploadKey & Readonly<{ purpose: ArtifactUploadPurpose }>,
): Promise<ArtifactRecord | undefined> {
  const [row] = await drizzle(client)
    .select()
    .from(artifacts)
    .where(and(uploadKey(input), eq(artifacts.purpose, input.purpose)))
    .for('update')
    .catch(rethrowQueryFailure);
  return row;
}

/** Undefined when the pending upload has expired. */
export async function markUploadAvailable(
  client: PoolClient,
  input: UploadKey & Readonly<{ retainForSeconds: number }>,
): Promise<ArtifactRecord | undefined> {
  const [finalized] = await drizzle(client)
    .update(artifacts)
    .set({
      status: 'available',
      finalizedAt: sql`clock_timestamp()`,
      expiresAt: sql`clock_timestamp()+make_interval(secs=>${input.retainForSeconds})`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        uploadKey(input),
        eq(artifacts.status, 'pending'),
        sql`${artifacts.expiresAt}>clock_timestamp()`,
      ),
    )
    .returning()
    .catch(rethrowQueryFailure);
  return finalized;
}

function uploadKey(input: UploadKey) {
  return and(
    eq(artifacts.workspaceId, input.workspaceId),
    eq(artifacts.id, input.artifactId),
  );
}

function isCapacityExceeded(error: unknown): boolean {
  const { code, detail } = postgresFailure(error);
  return code === 'P0001' && detail === 'artifact_capacity_exceeded';
}
