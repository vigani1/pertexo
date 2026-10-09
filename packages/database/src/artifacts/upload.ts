import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../platform/pool/runtime.js';
import { generatePersistedId } from '../platform/persisted-id.js';
import { claimCommand, completeCommand } from '../platform/idempotency.js';
import {
  checkDatabaseReadiness,
  type DatabaseReadiness,
} from '../platform/readiness.js';
import { rolesForCapability } from '../tenant-access/policy.js';
import { canonicalOutboxPayloadChecksum } from '../outbox/events.js';
import type { ArtifactRecord } from './store.js';
import { withTenantScopedClient } from '../tenant-access/transactions.js';
import { artifactMetadataMatches } from './metadata-contract.js';

import {
  ArtifactQuotaExceededError,
  ArtifactUploadConflictError,
  ArtifactUploadIdempotencyConflictError,
  ArtifactUploadNotFoundError,
  mapArtifact,
  normalizeBeginInput,
  normalizeFinalizeInput,
  normalizeIdentity,
  type ArtifactUploadAuthorization,
  type ArtifactUploadDatabase,
  type ArtifactUploadResult,
  type BeginArtifactUploadInput,
  type FinalizeArtifactUploadInput,
  type NormalizedBeginArtifactUploadInput,
} from './upload-contract.js';

export {
  ARTIFACT_UPLOAD_PENDING_MS,
  ARTIFACT_UPLOAD_PURPOSE,
  ArtifactQuotaExceededError,
  ArtifactUploadConflictError,
  ArtifactUploadIdempotencyConflictError,
  ArtifactUploadNotFoundError,
} from './upload-contract.js';
export type {
  ArtifactUploadActor,
  ArtifactUploadAuthorization,
  ArtifactUploadDatabase,
  ArtifactUploadIdentity,
  ArtifactUploadResult,
  BeginArtifactUploadInput,
  FinalizeArtifactUploadInput,
} from './upload-contract.js';

function isDatabaseError(
  error: unknown,
  code: string,
  detail: string,
): boolean {
  try {
    return (
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'code') === code &&
      Reflect.get(error, 'detail') === detail
    );
  } catch {
    return false;
  }
}

async function requireWorkspaceAccess(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  access: 'upload' | 'read',
): Promise<void> {
  const roles = rolesForCapability(
    access === 'upload' ? 'artifact:upload' : 'artifact:read',
  );
  const result = await client.query(
    `select 1
       from app.workspace_memberships membership
       join app.users actor on actor.id=membership.user_id
       join app.workspaces workspace on workspace.id=membership.workspace_id
      where membership.workspace_id=$1 and membership.user_id=$2
        and membership.status='active'
        and membership.role=any($3::text[])
        and actor.status='active' and workspace.status='active'
      for share of membership, actor, workspace`,
    [workspaceId, actorId, [...roles]],
  );
  if (result.rowCount !== 1) throw new ArtifactUploadNotFoundError();
}

async function loadArtifact(
  client: Pick<PoolClient, 'query'>,
  workspaceId: string,
  artifactId: string,
  statuses: readonly string[],
): Promise<ArtifactRecord> {
  const result = await client.query<Record<string, unknown>>(
    `select id,workspace_id,purpose,storage_key,media_type,byte_length,
            sha256,status,expires_at,finalized_at,deleted_at,retention_retry_at,
            created_at,updated_at
       from app.artifacts
      where workspace_id=$1 and id=$2 and status=any($3::text[])`,
    [workspaceId, artifactId, statuses],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ArtifactUploadNotFoundError();
  return mapArtifact(row);
}

const storedUploadSchema = z.object({ artifactId: z.uuid() }).strict();

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
      const artifactId = generatePersistedId();
      const command = {
        workspaceId: parsed.workspaceId,
        operation: 'artifact.upload',
        scope: `${parsed.actorId}:artifact-upload`,
        idempotencyKey: parsed.idempotencyKey,
        requestHash: uploadRequestHash(parsed),
        conflict: () => new ArtifactUploadIdempotencyConflictError(),
      };
      const stored = await claimCommand(client, {
        ...command,
        resourceId: artifactId,
      });
      if (stored !== null) {
        const artifact = await loadArtifact(
          client,
          parsed.workspaceId,
          storedUploadSchema.parse(stored).artifactId,
          ['pending', 'available'],
        );
        return Object.freeze({ artifact, replayed: true });
      }

      let artifact: ArtifactRecord;
      try {
        const inserted = await client.query<Record<string, unknown>>(
          `insert into app.artifacts
             (id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
              status,expires_at)
           values($1,$2,'user-upload',
              'workspaces/'||$2::uuid::text||'/artifacts/'||$1::uuid::text,
              $3,$4,$5,'pending',clock_timestamp()+interval '15 minutes')
           returning id,workspace_id,purpose,storage_key,media_type,byte_length,
                     sha256,status,expires_at,finalized_at,deleted_at,
                     retention_retry_at,created_at,updated_at`,
          [
            artifactId,
            parsed.workspaceId,
            parsed.mediaType,
            parsed.byteLength,
            parsed.sha256,
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined)
          throw new Error('Artifact upload insert returned no row');
        artifact = mapArtifact(row);
      } catch (error: unknown) {
        if (isDatabaseError(error, 'P0001', 'artifact_capacity_exceeded'))
          throw new ArtifactQuotaExceededError();
        throw error;
      }
      await completeCommand(client, command, { artifactId: artifact.id });
      return Object.freeze({ artifact, replayed: false });
    },
  );
}

async function readUploadArtifact(
  pool: Pool,
  input: ArtifactUploadAuthorization,
  access: 'upload' | 'read',
  statuses: readonly ArtifactRecord['status'][] = ['pending', 'available'],
  signal?: AbortSignal,
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
        return await loadArtifact(
          client,
          parsed.workspaceId,
          parsed.artifactId,
          statuses,
        );
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
      const result = await client.query<Record<string, unknown>>(
        `select id,workspace_id,purpose,storage_key,media_type,byte_length,
                sha256,status,expires_at,finalized_at,deleted_at,
                retention_retry_at,created_at,updated_at
           from app.artifacts
          where workspace_id=$1 and id=$2
          for update`,
        [parsed.workspaceId, parsed.artifactId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new ArtifactUploadNotFoundError();
      const artifact = mapArtifact(row);
      const expected = parsed.expectedMetadata;
      if (!artifactMetadataMatches(artifact, expected))
        throw new ArtifactUploadConflictError(
          'Artifact upload metadata does not match the declared object',
        );
      if (artifact.status === 'available') return artifact;
      if (artifact.status !== 'pending')
        throw new ArtifactUploadConflictError('Artifact upload is not pending');
      const finalized = await client.query<Record<string, unknown>>(
        `update app.artifacts
            set status='available',finalized_at=clock_timestamp(),
                expires_at=clock_timestamp()+interval '30 days',
                updated_at=clock_timestamp()
          where workspace_id=$1 and id=$2 and status='pending'
            and expires_at>clock_timestamp()
          returning id,workspace_id,purpose,storage_key,media_type,byte_length,
                    sha256,status,expires_at,finalized_at,deleted_at,
                    retention_retry_at,created_at,updated_at`,
        [parsed.workspaceId, parsed.artifactId],
      );
      const finalizedRow = finalized.rows[0];
      if (finalizedRow === undefined)
        throw new ArtifactUploadConflictError('Artifact upload has expired');
      return mapArtifact(finalizedRow);
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
    'upload',
    ['pending', 'available', 'deleting', 'deleted'],
    input.signal,
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
      readUploadArtifact(pool, input, 'upload'),
    finalizeUpload: (input: FinalizeArtifactUploadInput) =>
      finalizeUpload(pool, input),
    getMetadata: (input: ArtifactUploadAuthorization) =>
      readUploadArtifact(pool, input, 'read'),
    checkCompatibility: (): Promise<DatabaseReadiness> =>
      checkDatabaseReadiness(pool),
    checkReadiness: (): Promise<DatabaseReadiness> =>
      checkDatabaseReadiness(pool),
    close: lease.close,
  });
}
