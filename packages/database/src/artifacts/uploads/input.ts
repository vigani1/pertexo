import type {
  ArtifactUploadAuthorization,
  BeginArtifactUploadInput,
  FinalizeArtifactUploadInput,
  NormalizedArtifactIdentity,
  NormalizedBeginArtifactUploadInput,
  NormalizedFinalizeArtifactUploadInput,
} from './contract.js';

export const ARTIFACT_UPLOAD_PENDING_MS = 15 * 60 * 1_000;

export const ARTIFACT_UPLOAD_PURPOSE = 'user-upload';

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

export function normalizeBeginInput(
  input: BeginArtifactUploadInput,
): NormalizedBeginArtifactUploadInput {
  if (input.actor.workspaceId !== input.workspaceId)
    throw new ArtifactUploadNotFoundError();
  return {
    actorId: input.actor.actorId,
    byteLength: input.byteLength,
    idempotencyKey: input.idempotencyKey,
    mediaType: input.mediaType,
    sha256: input.sha256,
    workspaceId: input.workspaceId,
  };
}

export function normalizeIdentity(
  input: ArtifactUploadAuthorization,
): NormalizedArtifactIdentity {
  if (input.actor.workspaceId !== input.identity.workspaceId)
    throw new ArtifactUploadNotFoundError();
  return {
    actorId: input.actor.actorId,
    artifactId: input.identity.artifactId,
    workspaceId: input.identity.workspaceId,
  };
}

export function normalizeFinalizeInput(
  input: FinalizeArtifactUploadInput,
): NormalizedFinalizeArtifactUploadInput {
  if (input.actor.workspaceId !== input.identity.workspaceId)
    throw new ArtifactUploadNotFoundError();
  return {
    actorId: input.actor.actorId,
    artifactId: input.identity.artifactId,
    expectedMetadata: input.expectedMetadata,
    workspaceId: input.identity.workspaceId,
  };
}
