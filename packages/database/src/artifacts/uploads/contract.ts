import { z } from 'zod';

import type { ArtifactRecord } from '../repository.js';
import type { DatabaseReadiness } from '../../platform/readiness.js';
import {
  artifactByteLengthSchema,
  artifactMediaTypeSchema,
  artifactSha256Schema,
} from '../metadata/contract.js';

export const ARTIFACT_UPLOAD_PENDING_MS = 15 * 60 * 1_000;
export const ARTIFACT_UPLOAD_PURPOSE = 'user-upload';

const uuidSchema = z.uuid();
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
    byteLength: artifactByteLengthSchema,
    idempotencyKey: idempotencyKeySchema,
    mediaType: artifactMediaTypeSchema,
    sha256: artifactSha256Schema,
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
        byteLength: artifactByteLengthSchema,
        mediaType: artifactMediaTypeSchema,
        sha256: artifactSha256Schema,
      })
      .strict(),
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
> &
  Readonly<{
    /** Runs while expiry cleanup is excluded by the workspace lifecycle lock. */
    signal?: AbortSignal;
    verifyUpload?: () => Promise<void>;
  }>;

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
  checkReadiness(): Promise<DatabaseReadiness>;
  close(): Promise<void>;
}>;

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
  const parsed = finalizeArtifactUploadSchema.parse({
    actor: input.actor,
    expectedMetadata: input.expectedMetadata,
    identity: input.identity,
  });
  if (parsed.actor.workspaceId !== parsed.identity.workspaceId)
    throw new ArtifactUploadNotFoundError();
  return {
    actorId: parsed.actor.actorId,
    artifactId: parsed.identity.artifactId,
    expectedMetadata: parsed.expectedMetadata,
    workspaceId: parsed.identity.workspaceId,
  };
}
