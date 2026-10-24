import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { artifacts } from '../../schema/transport.js';
import { artifactStorageKey } from '../repository.js';
import { lockWorkspaceAuthority } from '../../tenant-access/workspaces/authority.js';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import { visibleArtifactIds } from '../references/access.queries.js';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import {
  claimCommand,
  completeCommand,
} from '../../platform/idempotency/repository.js';
import { checkDatabaseReadiness } from '../../platform/readiness.queries.js';
import type { DatabaseReadiness } from '../../platform/contract.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.repository.js';
import type { ArtifactRecord } from '../contract.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import { artifactMetadataMatches } from '../metadata/validation.js';

import {
  ARTIFACT_UPLOAD_PENDING_MS,
  ArtifactQuotaExceededError,
  ArtifactUploadConflictError,
  ArtifactUploadIdempotencyConflictError,
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
  try {
    await lockWorkspaceAuthority(client, workspaceId, actorId, roles);
  } catch (error) {
    if (error instanceof WorkspaceAccessDeniedError)
      throw new ArtifactUploadNotFoundError();
    throw error;
  }
}

async function loadArtifact(
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
        const [row] = await drizzle(client)
          .insert(artifacts)
          .values({
            id: artifactId,
            workspaceId: parsed.workspaceId,
            purpose: 'user-upload',
            storageKey: artifactStorageKey(
              parsed.workspaceId.toLowerCase(),
              artifactId,
            ),
            mediaType: parsed.mediaType,
            byteLength: parsed.byteLength,
            sha256: parsed.sha256,
            status: 'pending',
            expiresAt: sql`clock_timestamp()+make_interval(secs=>${ARTIFACT_UPLOAD_PENDING_MS / 1000})`,
          })
          .returning()
          .catch(rethrowQueryFailure);
        if (row === undefined)
          throw new Error('Artifact upload insert returned no row');
        artifact = Object.freeze(row);
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
          !(await visibleArtifactIds(client, parsed, [parsed.artifactId])).has(
            parsed.artifactId,
          )
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
      const db = drizzle(client);
      const predicate = and(
        eq(artifacts.workspaceId, parsed.workspaceId),
        eq(artifacts.id, parsed.artifactId),
      );
      const [row] = await db
        .select()
        .from(artifacts)
        .where(and(predicate, eq(artifacts.purpose, 'user-upload')))
        .for('update')
        .catch(rethrowQueryFailure);
      if (row === undefined) throw new ArtifactUploadNotFoundError();
      if (
        !(await visibleArtifactIds(client, parsed, [parsed.artifactId])).has(
          parsed.artifactId,
        )
      )
        throw new ArtifactUploadNotFoundError();
      const artifact = Object.freeze(row);
      const expected = parsed.expectedMetadata;
      if (!artifactMetadataMatches(artifact, expected))
        throw new ArtifactUploadConflictError(
          'Artifact upload metadata does not match the declared object',
        );
      if (artifact.status === 'available') return artifact;
      if (artifact.status !== 'pending')
        throw new ArtifactUploadConflictError('Artifact upload is not pending');
      const [finalizedRow] = await db
        .update(artifacts)
        .set({
          status: 'available',
          finalizedAt: sql`clock_timestamp()`,
          expiresAt: sql`clock_timestamp()+interval '30 days'`,
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
      if (finalizedRow === undefined)
        throw new ArtifactUploadConflictError('Artifact upload has expired');
      return Object.freeze(finalizedRow);
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
