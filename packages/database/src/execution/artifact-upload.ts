import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import type { DatabaseConfig } from '../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../platform/database-runtime.js';
import { generatePersistedId } from '../platform/persisted-id.js';
import {
  checkDatabaseReadiness,
  checkDatabaseServingReadiness,
  type DatabaseReadiness,
} from '../platform/readiness.js';
import { canonicalOutboxPayloadChecksum } from './outbox.js';
import type { ArtifactRecord } from './artifacts.js';
import { withTenantScopedClient } from '../tenant-access/workspace.js';

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
} from './artifact-upload-contract.js';

export {
  ARTIFACT_UPLOAD_PENDING_MS,
  ARTIFACT_UPLOAD_PURPOSE,
  ArtifactQuotaExceededError,
  ArtifactUploadConflictError,
  ArtifactUploadIdempotencyConflictError,
  ArtifactUploadNotFoundError,
} from './artifact-upload-contract.js';
export type {
  ArtifactUploadActor,
  ArtifactUploadAuthorization,
  ArtifactUploadDatabase,
  ArtifactUploadIdentity,
  ArtifactUploadResult,
  BeginArtifactUploadInput,
  FinalizeArtifactUploadInput,
} from './artifact-upload-contract.js';

function isDatabaseError(
  error: unknown,
  code: string,
  detail: string,
): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code &&
    'detail' in error &&
    error.detail === detail
  );
}

function keyDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

async function requireWorkspaceAccess(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  access: 'upload' | 'read',
): Promise<void> {
  const roles =
    access === 'upload'
      ? ['owner', 'admin', 'builder', 'operator']
      : ['owner', 'admin', 'builder', 'operator', 'viewer'];
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
    [workspaceId, actorId, roles],
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
      const requestHash = uploadRequestHash(parsed);
      const scope = `${parsed.actorId}:artifact-upload`;
      await client.query(
        `insert into app.idempotency_records
           (id,workspace_id,operation,scope,key_hash,request_hash,status,
            resource_id,result_ref)
         values($1,$2,'artifact.upload',$3,$4,$5,'in_progress',$6,'{}'::jsonb)
         on conflict(workspace_id,operation,scope,key_hash) do nothing`,
        [
          generatePersistedId(),
          parsed.workspaceId,
          scope,
          keyDigest(parsed.idempotencyKey),
          requestHash,
          artifactId,
        ],
      );
      const claimResult = await client.query<{
        request_hash: string;
        resource_id: string;
        result_ref: unknown;
        status: string;
      }>(
        `select request_hash,resource_id,result_ref,status
           from app.idempotency_records
          where workspace_id=$1 and operation='artifact.upload'
            and scope=$2 and key_hash=$3
          for update`,
        [parsed.workspaceId, scope, keyDigest(parsed.idempotencyKey)],
      );
      const claim = claimResult.rows[0];
      if (claim === undefined)
        throw new Error('Artifact upload idempotency claim is unavailable');
      if (claim.request_hash !== requestHash)
        throw new ArtifactUploadIdempotencyConflictError();
      if (claim.status === 'completed') {
        const artifact = await loadArtifact(
          client,
          parsed.workspaceId,
          claim.resource_id,
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
            claim.resource_id,
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
      await client.query(
        `update app.idempotency_records
            set status='completed',result_ref=$1::jsonb,
                updated_at=clock_timestamp()
          where workspace_id=$2 and operation='artifact.upload'
            and scope=$3 and key_hash=$4`,
        [
          JSON.stringify({ artifactId: artifact.id }),
          parsed.workspaceId,
          scope,
          keyDigest(parsed.idempotencyKey),
        ],
      );
      return Object.freeze({ artifact, replayed: false });
    },
  );
}

async function readUploadArtifact(
  pool: Pool,
  input: ArtifactUploadAuthorization,
  access: 'upload' | 'read',
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
          ['pending', 'available'],
        );
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
      if (
        artifact.byteLength !== expected.byteLength ||
        artifact.mediaType !== expected.mediaType ||
        artifact.sha256 !== expected.sha256
      )
        throw new ArtifactUploadConflictError(
          'Artifact upload metadata does not match the declared object',
        );
      if (artifact.status === 'available') return artifact;
      if (artifact.status !== 'pending')
        throw new ArtifactUploadConflictError('Artifact upload is not pending');
      const finalized = await client.query<Record<string, unknown>>(
        `update app.artifacts
            set status='available',finalized_at=clock_timestamp(),
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
  );
}

export function createArtifactUploadDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): ArtifactUploadDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  const readinessOptions = {
    ownerRole: config.ownerRole,
    workerRuntimeRole: config.workerRuntimeRole,
  } as const;
  return Object.freeze({
    beginUpload: (input: BeginArtifactUploadInput) => beginUpload(pool, input),
    getForUpload: (input: ArtifactUploadAuthorization) =>
      readUploadArtifact(pool, input, 'upload'),
    finalizeUpload: (input: FinalizeArtifactUploadInput) =>
      finalizeUpload(pool, input),
    getMetadata: (input: ArtifactUploadAuthorization) =>
      readUploadArtifact(pool, input, 'read'),
    checkCompatibility: (): Promise<DatabaseReadiness> =>
      checkDatabaseReadiness(pool, readinessOptions),
    checkReadiness: (): Promise<DatabaseReadiness> =>
      checkDatabaseServingReadiness(pool, readinessOptions),
    close: lease.close,
  });
}
