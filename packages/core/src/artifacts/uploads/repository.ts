import {
  lockBrowsableWorkspaceAuthority,
  lockWorkspaceAuthority,
} from '../../shared/authority.queries.js';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import { visibleArtifactIds } from '../references/access.queries.js';
import type { Pool, PoolClient } from 'pg';

import type {
  DatabaseConfig,
  DatabaseReadiness,
} from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  checkDatabaseReadiness,
  canonicalOutboxPayloadChecksum,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import {
  BROWSABLE_WORKSPACE_STATUSES,
  rolesForCapability,
} from '@pertexo/workflow-model';
import type { ArtifactRecord } from '../contract.js';
import { artifactMetadataMatches } from '../metadata/validation.js';

import {
  completeArtifactUpload,
  loadArtifact,
  reserveArtifactUpload,
} from './reservation.repository.js';
import {
  ArtifactUploadConflictError,
  ArtifactUploadNotFoundError,
  normalizeBeginInput,
  normalizeFinalizeInput,
  normalizeIdentity,
} from './input.js';
import type {
  ArtifactUploadAuthorization,
  ArtifactUploadDatabase,
  ArtifactUploadResult,
  BeginArtifactUploadInput,
  FinalizeArtifactUploadInput,
  NormalizedBeginArtifactUploadInput,
} from './contract.js';

async function requireWorkspaceAccess(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  access: 'upload' | 'read',
): Promise<void> {
  const roles = rolesForCapability(
    access === 'upload' ? 'artifact:upload' : 'artifact:read',
  );
  try {
    await (
      access === 'read'
        ? lockBrowsableWorkspaceAuthority
        : lockWorkspaceAuthority
    )(client, workspaceId, actorId, roles);
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
  return withTenantScopedClient(
    pool,
    { workspaceId: parsed.workspaceId, actorId: parsed.actorId },
    async (client) => {
      await requireWorkspaceAccess(
        client,
        parsed.workspaceId,
        parsed.actorId,
        'upload',
      );
      return reserveArtifactUpload(client, {
        workspaceId: parsed.workspaceId,
        purpose: 'user-upload',
        scope: `${parsed.actorId}:artifact-upload`,
        idempotencyKey: parsed.idempotencyKey,
        requestHash: uploadRequestHash(parsed),
        metadata: parsed,
      });
    },
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
  return withTenantScopedClient(
    pool,
    { workspaceId: parsed.workspaceId, actorId: parsed.actorId },
    async (client) => {
      await requireWorkspaceAccess(
        client,
        parsed.workspaceId,
        parsed.actorId,
        access,
      );
      try {
        if (
          !(
            await visibleArtifactIds(
              client,
              parsed,
              [parsed.artifactId],
              access === 'read' ? BROWSABLE_WORKSPACE_STATUSES : undefined,
            )
          ).has(parsed.artifactId)
        )
          return null;
        const artifact = await loadArtifact(
          client,
          parsed.workspaceId,
          parsed.artifactId,
          statuses,
        );
        return access === 'upload' && artifact.purpose !== 'user-upload'
          ? null
          : artifact;
      } catch (error: unknown) {
        if (error instanceof ArtifactUploadNotFoundError) return null;
        throw error;
      }
    },
    signal === undefined ? {} : { signal },
  );
}

async function completeUploadFinalization(
  pool: Pool,
  input: FinalizeArtifactUploadInput,
  signal?: AbortSignal,
): Promise<ArtifactRecord> {
  const parsed = normalizeFinalizeInput(input);
  return withTenantScopedClient(
    pool,
    { workspaceId: parsed.workspaceId, actorId: parsed.actorId },
    async (client) => {
      await requireWorkspaceAccess(
        client,
        parsed.workspaceId,
        parsed.actorId,
        'upload',
      );
      if (
        !(await visibleArtifactIds(client, parsed, [parsed.artifactId])).has(
          parsed.artifactId,
        )
      )
        throw new ArtifactUploadNotFoundError();
      return completeArtifactUpload(client, {
        workspaceId: parsed.workspaceId,
        artifactId: parsed.artifactId,
        purpose: 'user-upload',
        expectedMetadata: parsed.expectedMetadata,
        retainFor: '30 days',
      });
    },
    signal === undefined ? {} : { signal },
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
  return completeUploadFinalization(pool, input, input.signal);
}

export function createArtifactUploadDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): ArtifactUploadDatabase {
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
