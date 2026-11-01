import type { ArtifactMetadataIdentity } from './metadata/contract.js';

export function artifactMetadataMatches(
  actual: ArtifactMetadataIdentity,
  expected: ArtifactMetadataIdentity,
): boolean {
  return (
    actual.byteLength === expected.byteLength &&
    actual.mediaType === expected.mediaType &&
    actual.sha256 === expected.sha256
  );
}
