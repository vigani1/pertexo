import type {
  ArtifactDownloadCapability,
  ArtifactStore as StoredArtifacts,
} from '@pertexo/artifact-store';

/** Keep the API seam tied to the single server-only store contract. */
export type ArtifactStore = Pick<
  StoredArtifacts & ArtifactDownloadCapability,
  | 'beginDirectDownload'
  | 'beginDirectUpload'
  | 'checkReadiness'
  | 'close'
  | 'validateDirectUpload'
>;
