import { metadataSchema } from './artifact-request.schemas.js';
import type {
  GetObjectCommandOutput,
  HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';

import type { ArtifactIdentity } from '../artifact-identity.js';
import { ArtifactIntegrityError } from '../artifact-store.errors.js';

import type { ArtifactMetadata } from './artifact-storage.types.js';

const STORAGE_METADATA = {
  artifactId: 'artifact-id',
  byteLength: 'byte-length',
  mediaType: 'media-type',
  sha256: 'sha256',
  workspaceId: 'workspace-id',
} as const;

const USER_METADATA_KEYS = Object.values(STORAGE_METADATA).toSorted();

export const DIRECT_UPLOAD_SIGNABLE_HEADERS = new Set([
  'content-length',
  'content-type',
  'if-none-match',
]);

export const DIRECT_UPLOAD_UNHOISTABLE_HEADERS = new Set([
  'x-amz-checksum-sha256',
  ...USER_METADATA_KEYS.map((key) => `x-amz-meta-${key}`),
]);

export function objectMetadata(
  metadata: ArtifactMetadata,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [STORAGE_METADATA.artifactId]: metadata.artifactId,
    [STORAGE_METADATA.byteLength]: String(metadata.byteLength),
    [STORAGE_METADATA.mediaType]: metadata.mediaType,
    [STORAGE_METADATA.sha256]: metadata.sha256,
    [STORAGE_METADATA.workspaceId]: metadata.workspaceId,
  });
}

export function checksumSha256Base64(sha256: string): string {
  return Buffer.from(sha256, 'hex').toString('base64');
}

export function metadataFromHead(
  identity: ArtifactIdentity,
  output: HeadObjectCommandOutput | GetObjectCommandOutput,
  maxObjectBytes: number,
): ArtifactMetadata {
  const metadata = output.Metadata ?? {};
  const metadataKeys = Object.keys(metadata).toSorted();
  const parsedByteLength = Number(metadata[STORAGE_METADATA.byteLength]);
  const storedContentType = output.ContentType?.replace(/\s*;\s*/gu, ';');
  const candidate = metadataSchema.safeParse({
    artifactId: metadata[STORAGE_METADATA.artifactId],
    byteLength: parsedByteLength,
    mediaType: metadata[STORAGE_METADATA.mediaType],
    sha256: metadata[STORAGE_METADATA.sha256],
    workspaceId: metadata[STORAGE_METADATA.workspaceId],
  });

  const invalidStoredMetadata =
    !candidate.success ||
    metadataKeys.length !== USER_METADATA_KEYS.length ||
    metadataKeys.some((key, index) => key !== USER_METADATA_KEYS[index]) ||
    candidate.data.artifactId !== identity.artifactId ||
    candidate.data.workspaceId !== identity.workspaceId ||
    candidate.data.byteLength > maxObjectBytes ||
    output.ContentLength !== candidate.data.byteLength ||
    storedContentType !== candidate.data.mediaType.replace(/\s*;\s*/gu, ';');
  if (invalidStoredMetadata) {
    throw new ArtifactIntegrityError('Stored artifact metadata is invalid');
  }

  return Object.freeze(candidate.data);
}

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
