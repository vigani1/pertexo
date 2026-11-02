import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseReadiness,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  canonicalOutboxPayloadChecksum,
  checkDatabaseReadiness,
} from '@pertexo/database/primitives';
import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
} from '@pertexo/workflow-model';
import type { Pool, PoolClient } from 'pg';

import { withWorkspaceAccess } from '../../shared/workspace-access.js';
import { WorkspaceAccessDeniedError } from '../../shared/errors.js';
import { ARTIFACT_UPLOAD_PURPOSE, type ArtifactRecord } from '../contract.js';
import { artifactMetadataMatches } from '../metadata.js';
import { visibleArtifactIds } from '../references/access.queries.js';
import type {
  ArtifactUploadAuthorization,
  ArtifactUploadResult,
  BeginArtifactUploadInput,
  FinalizeArtifactUploadInput,
  NormalizedBeginArtifactUploadInput,
} from './contract.js';
import {
  ArtifactUploadConflictError,
  ArtifactUploadNotFoundError,
} from './errors.js';
import {
  normalizeBeginInput,
  normalizeFinalizeInput,
  normalizeIdentity,
} from './input.js';
import {
  completeArtifactUpload,
  loadArtifact,
  reserveArtifactUpload,
} from './reservation.repository.js';

export type ArtifactUploadStore = ReturnType<typeof createArtifactUploadStore>;

export function createArtifactUploadStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    beginUpload: (input: BeginArtifactUploadInput) => beginUpload(pool, input),
    getForUpload: (input: ArtifactUploadAuthorization) =>
      readUploadArtifact(pool, input, { access: 'upload' }),
    finalizeUpload: (input: FinalizeArtifactUploadInput) =>
      finalizeUpload(pool, input),
    getMetadata: (input: ArtifactUploadAuthorization) =>
      readUploadArtifact(pool, input, { access: 'read' }),
    checkReadiness: (): Promise<DatabaseReadiness> =>
      checkDatabaseReadiness(pool),
    close: lease.close,
  });
}

/** Someone without access gets "not found" rather than learning a file exists. */
async function withUploadAccess<T>(
  pool: Pool,
  {
    workspaceId,
    actorId,
    access,
    signal,
  }: Readonly<{
    workspaceId: string;
    actorId: string;
    access: 'upload' | 'read';
    signal?: AbortSignal | undefined;
  }>,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    return await withWorkspaceAccess(
      pool,
      { workspaceId, actorId, ...(signal === undefined ? {} : { signal }) },
      access === 'upload'
        ? {
            mode: 'change',
            capability: 'artifact:upload',
            statuses: ACTIVE_WORKSPACE_STATUSES,
          }
        : {
            mode: 'change',
            capability: 'artifact:read',
            statuses: BROWSABLE_WORKSPACE_STATUSES,
          },
      work,
    );
  } catch (error) {
    if (error instanceof WorkspaceAccessDeniedError)
      throw new ArtifactUploadNotFoundError();
    throw error;
  }
}

function uploadRequestHash(input: NormalizedBeginArtifactUploadInput): string {
  return canonicalOutboxPayloadChecksum({
    actorId: input.actorId,
    byteLength: input.byteLength,
    mediaType: input.mediaType,
    operation: 'artifact.upload',
    sha256: input.sha256,
    workspaceId: input.workspaceId,
  });
}

async function beginUpload(
  pool: Pool,
  input: BeginArtifactUploadInput,
): Promise<ArtifactUploadResult> {
  const parsed = normalizeBeginInput(input);
  return withUploadAccess(pool, { ...parsed, access: 'upload' }, (client) =>
    reserveArtifactUpload(client, {
      workspaceId: parsed.workspaceId,
      purpose: ARTIFACT_UPLOAD_PURPOSE,
      scope: `${parsed.actorId}:artifact-upload`,
      idempotencyKey: parsed.idempotencyKey,
      requestHash: uploadRequestHash(parsed),
      metadata: parsed,
    }),
  );
}

async function readUploadArtifact(
  pool: Pool,
  input: ArtifactUploadAuthorization,
  {
    access,
    statuses = ['pending', 'available'],
    signal,
  }: Readonly<{
    access: 'upload' | 'read';
    statuses?: readonly ArtifactRecord['status'][] | undefined;
    signal?: AbortSignal | undefined;
  }>,
): Promise<ArtifactRecord | null> {
  const parsed = normalizeIdentity(input);
  return withUploadAccess(
    pool,
    { ...parsed, access, signal },
    async (client) => {
      try {
        const visible = await visibleArtifactIds(
          client,
          parsed,
          [parsed.artifactId],
          access === 'read' ? BROWSABLE_WORKSPACE_STATUSES : undefined,
        );
        if (!visible.has(parsed.artifactId)) return null;
        const artifact = await loadArtifact(
          client,
          parsed.workspaceId,
          parsed.artifactId,
          statuses,
        );
        return access === 'upload' &&
          artifact.purpose !== ARTIFACT_UPLOAD_PURPOSE
          ? null
          : artifact;
      } catch (error: unknown) {
        if (error instanceof ArtifactUploadNotFoundError) return null;
        throw error;
      }
    },
  );
}

async function finalizeUpload(
  pool: Pool,
  input: FinalizeArtifactUploadInput,
): Promise<ArtifactRecord> {
  input.signal?.throwIfAborted();
  const parsed = normalizeFinalizeInput(input);
  const artifact = await readUploadArtifact(
    pool,
    { actor: input.actor, identity: input.identity },
    {
      access: 'upload',
      statuses: ['pending', 'available', 'deleting', 'deleted'],
      signal: input.signal,
    },
  );
  if (artifact === null) throw new ArtifactUploadNotFoundError();
  if (!artifactMetadataMatches(artifact, parsed.expectedMetadata))
    throw new ArtifactUploadConflictError(
      'Artifact upload metadata does not match the declared object',
    );
  if (artifact.status === 'available') return artifact;
  if (artifact.status !== 'pending')
    throw new ArtifactUploadConflictError('Artifact upload is not pending');
  await input.verifyUpload?.();
  input.signal?.throwIfAborted();
  // Finalizing requires the artifact to still be pending, so an upload that
  // expiry cleanup started deleting meanwhile fails instead.
  return withUploadAccess(
    pool,
    { ...parsed, access: 'upload', signal: input.signal },
    async (client) => {
      const visible = await visibleArtifactIds(client, parsed, [
        parsed.artifactId,
      ]);
      if (!visible.has(parsed.artifactId))
        throw new ArtifactUploadNotFoundError();
      return completeArtifactUpload(client, {
        workspaceId: parsed.workspaceId,
        artifactId: parsed.artifactId,
        purpose: ARTIFACT_UPLOAD_PURPOSE,
        expectedMetadata: parsed.expectedMetadata,
        retainFor: '30 days',
      });
    },
  );
}
