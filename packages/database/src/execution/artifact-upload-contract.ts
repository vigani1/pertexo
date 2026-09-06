import { z } from 'zod';

import type { ArtifactRecord } from './artifacts.js';
import type { DatabaseReadiness } from '../platform/readiness.js';

export const ARTIFACT_UPLOAD_PENDING_MS = 15 * 60 * 1_000;
export const ARTIFACT_UPLOAD_PURPOSE = 'user-upload';

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024 * 1024;
const uuidSchema = z.uuid();
const byteLengthSchema = z.number().int().min(0).max(MAX_ARTIFACT_BYTES);
const mediaTypeSchema = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .regex(/^[^\s/;]+\/[^\r\n]+$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u)
  .refine((value) => !value.includes(','));
const actorInputSchema = z.looseObject({
  actorId: uuidSchema,
  workspaceId: uuidSchema,
});

const artifactIdentitySchema = z
  .object({
    workspaceId: uuidSchema,
    artifactId: uuidSchema,
  })
  .strict();

const beginArtifactUploadSchema = z
  .object({
    actor: actorInputSchema,
    byteLength: byteLengthSchema,
    idempotencyKey: idempotencyKeySchema,
    mediaType: mediaTypeSchema,
    sha256: sha256Schema,
    workspaceId: uuidSchema,
  })
  .strict();

const artifactUploadIdentitySchema = z
  .object({
    actor: actorInputSchema,
    identity: artifactIdentitySchema,
  })
  .strict();

const finalizeArtifactUploadSchema = artifactUploadIdentitySchema
  .extend({
    expectedMetadata: z
      .object({
        byteLength: byteLengthSchema,
        mediaType: mediaTypeSchema,
        sha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

const artifactRowSchema = z
  .object({
    id: uuidSchema,
    workspace_id: uuidSchema,
    purpose: z.string().min(1).max(64),
    storage_key: z.string().min(1).max(512),
    media_type: z.string().min(3).max(255),
    byte_length: z.union([z.number(), z.string()]),
    sha256: sha256Schema,
    status: z.enum(['pending', 'available', 'deleting', 'deleted']),
    expires_at: z.coerce.date(),
    finalized_at: z.coerce.date().nullable(),
    deleted_at: z.coerce.date().nullable(),
    retention_retry_at: z.coerce.date().nullable(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .strict();

export type ArtifactUploadActor = Readonly<z.input<typeof actorInputSchema>>;
export type ArtifactUploadIdentity = z.input<typeof artifactIdentitySchema>;
export type ArtifactUploadAuthorization = Readonly<
  z.input<typeof artifactUploadIdentitySchema>
>;
export type BeginArtifactUploadInput = z.input<
  typeof beginArtifactUploadSchema
>;
export type FinalizeArtifactUploadInput = z.input<
  typeof finalizeArtifactUploadSchema
>;

export type NormalizedArtifactIdentity = Readonly<{
  actorId: string;
  artifactId: string;
  workspaceId: string;
}>;

export type NormalizedBeginArtifactUploadInput = Readonly<{
  actorId: string;
  byteLength: number;
  idempotencyKey: string;
  mediaType: string;
  sha256: string;
  workspaceId: string;
}>;

export type NormalizedFinalizeArtifactUploadInput = NormalizedArtifactIdentity &
  Readonly<{
    expectedMetadata: Readonly<{
      byteLength: number;
      mediaType: string;
      sha256: string;
    }>;
  }>;

export type ArtifactUploadResult = Readonly<{
  artifact: ArtifactRecord;
  replayed: boolean;
}>;

export class ArtifactQuotaExceededError extends Error {
  public readonly code = 'workspace.quota_exceeded' as const;

  public constructor() {
    super('workspace.quota_exceeded');
    this.name = 'ArtifactQuotaExceededError';
  }
}

export class ArtifactUploadConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArtifactUploadConflictError';
  }
}

export class ArtifactUploadIdempotencyConflictError extends Error {
  public constructor() {
    super('request.idempotency_conflict');
    this.name = 'ArtifactUploadIdempotencyConflictError';
  }
}

export class ArtifactUploadNotFoundError extends Error {
  public constructor() {
    super('Artifact upload metadata was not found in the workspace');
    this.name = 'ArtifactUploadNotFoundError';
  }
}

export type ArtifactUploadDatabase = Readonly<{
  beginUpload(input: BeginArtifactUploadInput): Promise<ArtifactUploadResult>;
  getForUpload(
    input: ArtifactUploadAuthorization,
  ): Promise<ArtifactRecord | null>;
  finalizeUpload(input: FinalizeArtifactUploadInput): Promise<ArtifactRecord>;
  getMetadata(
    input: ArtifactUploadAuthorization,
  ): Promise<ArtifactRecord | null>;
  checkCompatibility(): Promise<DatabaseReadiness>;
  checkReadiness(): Promise<DatabaseReadiness>;
  close(): Promise<void>;
}>;

export function mapArtifact(row: Record<string, unknown>): ArtifactRecord {
  const parsed = artifactRowSchema.parse(row);
  const byteLength = Number(parsed.byte_length);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0)
    throw new Error('Artifact byte length is outside the safe integer range');
  return Object.freeze({
    id: parsed.id,
    workspaceId: parsed.workspace_id,
    purpose: parsed.purpose,
    storageKey: parsed.storage_key,
    mediaType: parsed.media_type,
    byteLength,
    sha256: parsed.sha256,
    status: parsed.status,
    expiresAt: parsed.expires_at,
    finalizedAt: parsed.finalized_at,
    deletedAt: parsed.deleted_at,
    retentionRetryAt: parsed.retention_retry_at,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  });
}

export function normalizeBeginInput(
  input: BeginArtifactUploadInput,
): NormalizedBeginArtifactUploadInput {
  const parsed = beginArtifactUploadSchema.parse(input);
  if (parsed.actor.workspaceId !== parsed.workspaceId)
    throw new ArtifactUploadNotFoundError();
  return {
    actorId: parsed.actor.actorId,
    byteLength: parsed.byteLength,
    idempotencyKey: parsed.idempotencyKey,
    mediaType: parsed.mediaType,
    sha256: parsed.sha256,
    workspaceId: parsed.workspaceId,
  };
}

export function normalizeIdentity(
  input: ArtifactUploadAuthorization,
): NormalizedArtifactIdentity {
  const parsed = artifactUploadIdentitySchema.parse(input);
  if (parsed.actor.workspaceId !== parsed.identity.workspaceId)
    throw new ArtifactUploadNotFoundError();
  return {
    actorId: parsed.actor.actorId,
    artifactId: parsed.identity.artifactId,
    workspaceId: parsed.identity.workspaceId,
  };
}

export function normalizeFinalizeInput(
  input: FinalizeArtifactUploadInput,
): NormalizedFinalizeArtifactUploadInput {
  const parsed = finalizeArtifactUploadSchema.parse(input);
  if (parsed.actor.workspaceId !== parsed.identity.workspaceId)
    throw new ArtifactUploadNotFoundError();
  return {
    actorId: parsed.actor.actorId,
    artifactId: parsed.identity.artifactId,
    expectedMetadata: parsed.expectedMetadata,
    workspaceId: parsed.identity.workspaceId,
  };
}
