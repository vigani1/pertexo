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
  const parsed = input;
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
  const parsed = input;
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
  const parsed = {
    actor: input.actor,
    expectedMetadata: input.expectedMetadata,
    identity: input.identity,
  };
  if (parsed.actor.workspaceId !== parsed.identity.workspaceId)
    throw new ArtifactUploadNotFoundError();
  return {
    actorId: parsed.actor.actorId,
    artifactId: parsed.identity.artifactId,
    expectedMetadata: parsed.expectedMetadata,
    workspaceId: parsed.identity.workspaceId,
  };
}
