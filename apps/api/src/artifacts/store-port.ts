import type { DualRegionArtifactStore } from '@pertexo/artifact-store';

/** Keep the API seam tied to the single server-only store contract. */
export type ArtifactStore = Pick<
  DualRegionArtifactStore,
  | 'beginDirectDownload'
  | 'beginDirectUpload'
  | 'checkReadiness'
  | 'close'
  | 'validateDirectUpload'
>;
