import { PutObjectCommand } from '@aws-sdk/client-s3';

import { artifactStorageKey } from '../identity.js';

import type { ArtifactStoreConfig } from '../config/index.js';

import { awaitWithSignal } from '../s3/request-lifecycle.js';

import type {
  BeginDirectUploadRequest,
  DirectUpload,
  PutObjectPresigner,
} from './contract.js';
import {
  DIRECT_UPLOAD_SIGNABLE_HEADERS,
  DIRECT_UPLOAD_UNHOISTABLE_HEADERS,
  objectMetadata,
  checksumSha256Base64,
} from './metadata.js';

export async function signArtifactUpload({
  config,
  presignPutObject,
  metadata,
  signal,
  issuedAt,
}: Readonly<{
  config: ArtifactStoreConfig;
  presignPutObject: PutObjectPresigner;
  metadata: BeginDirectUploadRequest;
  signal: AbortSignal;
  issuedAt: number;
}>): Promise<DirectUpload> {
  const checksum = checksumSha256Base64(metadata.sha256);
  const storedMetadata = objectMetadata(metadata);
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    ChecksumSHA256: checksum,
    ContentLength: metadata.byteLength,
    ContentType: metadata.mediaType,
    IfNoneMatch: '*',
    Key: artifactStorageKey(metadata),
    Metadata: storedMetadata,
  });
  const url = await awaitWithSignal(
    presignPutObject({
      command,
      expiresInSeconds: metadata.expiresInSeconds,
      signal,
      signableHeaders: DIRECT_UPLOAD_SIGNABLE_HEADERS,
      unhoistableHeaders: DIRECT_UPLOAD_UNHOISTABLE_HEADERS,
    }),
    signal,
  );
  signal.throwIfAborted();
  const headers = Object.freeze({
    'content-length': String(metadata.byteLength),
    'content-type': metadata.mediaType,
    'if-none-match': '*',
    'x-amz-checksum-sha256': checksum,
    ...Object.fromEntries(
      Object.entries(storedMetadata).map(([key, value]) => [
        `x-amz-meta-${key}`,
        value,
      ]),
    ),
  });
  return Object.freeze({
    expiresAt: new Date(
      issuedAt + metadata.expiresInSeconds * 1_000,
    ).toISOString(),
    expiresInSeconds: metadata.expiresInSeconds,
    headers,
    method: 'PUT' as const,
    url,
  });
}
