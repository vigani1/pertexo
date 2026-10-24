import type { z } from 'zod';

import type { ArtifactRecord } from '../contract.js';

import type { DatabaseReadiness } from '../../platform/readiness.queries.js';

import type {
  actorInputSchema,
  artifactIdentitySchema,
  beginArtifactUploadSchema,
  artifactUploadIdentitySchema,
  finalizeArtifactUploadSchema,
} from './input.js';

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
