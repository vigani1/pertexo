type ComparableArtifactMetadata = Readonly<{
  artifactId: string;
  workspaceId: string;
  byteLength: number;
  mediaType: string;
  sha256: string;
}>;

export function artifactMetadataMatches(
  actual: ComparableArtifactMetadata,
  expected: ComparableArtifactMetadata,
): boolean {
  return (
    actual.artifactId === expected.artifactId &&
    actual.workspaceId === expected.workspaceId &&
    actual.byteLength === expected.byteLength &&
    actual.mediaType === expected.mediaType &&
    actual.sha256 === expected.sha256
  );
}
