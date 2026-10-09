export const MINIMUM_ARTIFACT_RETENTION_MILLIS = 60_000;
export const MAXIMUM_ARTIFACT_RETENTION_MILLIS = 365 * 24 * 60 * 60_000;
const MAXIMUM_NODE_ARTIFACT_BYTES = 10_485_760;

type ArtifactIdentity = Readonly<{
  artifactId: string;
  workspaceId: string;
  byteLength: number;
  mediaType: string;
  sha256: string;
}>;

export function assertArtifactByteLimit(maxBytes: number): void {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAXIMUM_NODE_ARTIFACT_BYTES
  )
    throw new TypeError('Node artifact byte limit is invalid');
}

export function artifactExpiry(
  createdAt: Date,
  retentionMillis: number,
  retentionDeadline: Date | undefined,
): Date {
  const createdAtMillis = createdAt.getTime();
  if (
    !Number.isFinite(createdAtMillis) ||
    (retentionDeadline !== undefined &&
      !Number.isFinite(retentionDeadline.getTime()))
  )
    throw new TypeError('Artifact retention clock or deadline is invalid');
  const defaultExpiry = new Date(createdAtMillis + retentionMillis);
  if (!Number.isFinite(defaultExpiry.getTime()))
    throw new TypeError('Artifact retention expiry is outside the Date range');
  const expiresAt =
    retentionDeadline !== undefined &&
    retentionDeadline.getTime() < defaultExpiry.getTime()
      ? new Date(retentionDeadline.getTime())
      : defaultExpiry;
  if (expiresAt.getTime() <= createdAtMillis)
    throw new RangeError('Artifact retention deadline has expired');
  return expiresAt;
}

export function assertUploadedArtifactMatches(
  uploaded: ArtifactIdentity,
  expected: ArtifactIdentity,
): void {
  if (
    uploaded.artifactId !== expected.artifactId ||
    uploaded.workspaceId !== expected.workspaceId ||
    uploaded.byteLength !== expected.byteLength ||
    uploaded.mediaType !== expected.mediaType ||
    uploaded.sha256 !== expected.sha256
  )
    throw new Error('Artifact store returned incompatible metadata');
}
