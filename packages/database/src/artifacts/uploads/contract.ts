import type { ArtifactRecord } from '../contract.js';
import type { ArtifactMetadataIdentity } from '../metadata/contract.js';

import type { DatabaseReadiness } from '../../platform/contract.js';

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
