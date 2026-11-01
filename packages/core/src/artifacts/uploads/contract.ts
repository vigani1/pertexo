import type { ArtifactRecord } from '../contract.js';
import type { ArtifactMetadataIdentity } from '../metadata.js';

export const ARTIFACT_UPLOAD_PENDING_MS = 15 * 60 * 1_000;

export type ArtifactUploadActor = Readonly<{
  [key: string]: unknown;
  actorId: string;
  workspaceId: string;
}>;
export type ArtifactUploadIdentity = Readonly<{
  workspaceId: string;
  artifactId: string;
}>;
export type ArtifactUploadAuthorization = Readonly<{
  actor: ArtifactUploadActor;
  identity: ArtifactUploadIdentity;
}>;
export type BeginArtifactUploadInput = ArtifactMetadataIdentity &
  Readonly<{
    actor: ArtifactUploadActor;
    workspaceId: string;
    idempotencyKey: string;
  }>;
export type FinalizeArtifactUploadInput = ArtifactUploadAuthorization &
  Readonly<{
    expectedMetadata: ArtifactMetadataIdentity;
    signal?: AbortSignal;
    /** Runs while expiry cleanup is excluded by the workspace lifecycle lock. */ verifyUpload?: () => Promise<void>;
  }>;
export type NormalizedArtifactIdentity = ArtifactUploadIdentity &
  Readonly<{ actorId: string }>;
export type NormalizedBeginArtifactUploadInput = Omit<
  BeginArtifactUploadInput,
  'actor'
> &
  Readonly<{ actorId: string }>;
export type NormalizedFinalizeArtifactUploadInput = NormalizedArtifactIdentity &
  Readonly<{ expectedMetadata: ArtifactMetadataIdentity }>;

export type ArtifactUploadResult = Readonly<{
  artifact: ArtifactRecord;
  replayed: boolean;
}>;
