import type {
  ArtifactUploadAuthorization,
  BeginArtifactUploadInput,
  FinalizeArtifactUploadInput,
  NormalizedArtifactIdentity,
  NormalizedBeginArtifactUploadInput,
  NormalizedFinalizeArtifactUploadInput,
} from './contract.js';
import { ArtifactUploadNotFoundError } from './errors.js';

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
