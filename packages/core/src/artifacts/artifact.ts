import type { artifacts } from '@pertexo/database/schema';

export const ARTIFACT_STATUS = {
  available: 'available',
  deleted: 'deleted',
  deleting: 'deleting',
  pending: 'pending',
} as const;

export type ArtifactStatus =
  (typeof ARTIFACT_STATUS)[keyof typeof ARTIFACT_STATUS];

export type ArtifactRecord = typeof artifacts.$inferSelect;

/** Who may upload decides the purpose; both share one lifecycle and quota. */
export const ARTIFACT_UPLOAD_PURPOSE = 'user-upload';
export const FORM_UPLOAD_PURPOSE = 'form-upload';
export type ArtifactUploadPurpose =
  typeof ARTIFACT_UPLOAD_PURPOSE | typeof FORM_UPLOAD_PURPOSE;

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
