import type { artifacts } from '../schema.js';

import type { ARTIFACT_STATUS } from './input.js';

export type ArtifactStatus =
  (typeof ARTIFACT_STATUS)[keyof typeof ARTIFACT_STATUS];

export type ArtifactRecord = typeof artifacts.$inferSelect;

type ArtifactMetadataInput = Pick<
  ArtifactRecord,
  'byteLength' | 'mediaType' | 'sha256' | 'storageKey'
> &
  Readonly<{ artifactId: string }>;
export type CreatePendingArtifactInput = ArtifactMetadataInput &
  Readonly<{ expiresAt: Date; purpose: string }>;
export type CreatePendingPreviewArtifactInput = CreatePendingArtifactInput &
  Readonly<{ previewRunId: string }>;
export type FinalizeArtifactInput = ArtifactMetadataInput &
  Pick<ArtifactRecord, 'workspaceId'>;
export type ClaimDueUnfinalizedArtifactsInput = Readonly<{ limit: number }>;
export type ClaimDueUnfinalizedArtifactInput = Readonly<{ artifactId: string }>;
export type CompleteArtifactRemovalInput = Readonly<{ artifactId: string }>;
