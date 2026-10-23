import { S3Client } from '@aws-sdk/client-s3';

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { ArtifactStoreConfig } from './config/index.js';
import {
  createProductionObjectStoreObserver,
  ObservedS3Client,
  observePresign,
} from './s3/telemetry.js';
import type { ObjectStoreObserver } from './s3/telemetry.js';

import {
  createArtifactDownloadPresigner,
  type ArtifactDownloadCapability,
  type GetObjectPresigner,
} from './download.js';

import type {
  S3ClientLike,
  PutObjectPresigner,
  ArtifactStore,
  WorkspaceObjectPurgeStore,
} from './storage/contract.js';

import { ObservedArtifactStore } from './storage/observed.js';
import { AwsArtifactStore } from './storage/aws.js';
export {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  ArtifactStoreClosedError,
} from './errors.js';
export type { ArtifactIdentity } from './identity.js';
export {
  type S3ClientLike,
  type ArtifactMetadata,
  type PutArtifactRequest,
  type ArtifactRequest,
  type ArtifactDownload,
  type BeginDirectUploadRequest,
  type ValidateDirectUploadRequest,
  type DirectUpload,
  type PutObjectPresignRequest,
  type PutObjectPresigner,
  type ArtifactStoreReadiness,
  type ArtifactStore,
  type PurgeWorkspaceObjectsRequest,
  type WorkspaceObjectPurgePage,
  type WorkspaceObjectPurgeStore,
} from './storage/contract.js';

export function createArtifactStore(
  config: ArtifactStoreConfig,
  options: Readonly<{
    client?: S3ClientLike;
    clientOwnership?: 'borrowed' | 'owned';
    observer?: ObjectStoreObserver;
    presignGetObject?: GetObjectPresigner;
    presignPutObject?: PutObjectPresigner;
  }> = {},
): ArtifactStore & ArtifactDownloadCapability & WorkspaceObjectPurgeStore {
  const observer = options.observer ?? createProductionObjectStoreObserver();
  const rawClient =
    options.client ??
    new S3Client({
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      region: config.region,
    });
  const ownsClient =
    options.client === undefined || options.clientOwnership === 'owned';
  const client = new ObservedS3Client(rawClient, observer);
  const rawPresignPutObject: PutObjectPresigner =
    options.presignPutObject ??
    (async (request) =>
      getSignedUrl(rawClient as S3Client, request.command, {
        expiresIn: request.expiresInSeconds,
        signableHeaders: new Set(request.signableHeaders),
        unhoistableHeaders: new Set(request.unhoistableHeaders),
      }));
  const presignPutObject: PutObjectPresigner = (request) =>
    observePresign(observer, () => rawPresignPutObject(request));
  const store = new AwsArtifactStore({
    config,
    client,
    presignPutObject,
    presignGetObject: createArtifactDownloadPresigner(
      rawClient as S3Client,
      observer,
      options.presignGetObject,
    ),
    ownsClient,
  });
  return new ObservedArtifactStore(store, observer);
}
