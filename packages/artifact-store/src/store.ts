import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  GetBucketLocationCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  GetObjectCommandOutput,
  HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import { verifiedBody } from './stream-verification.js';

import { artifactMetadataMatches } from './metadata.js';
import {
  artifactIdentitySchema,
  artifactStorageKey,
  type ArtifactIdentity,
} from './identity.js';
import {
  ArtifactInputIntegrityError,
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  ArtifactStoreClosedError,
} from './errors.js';
import type { ArtifactStoreConfig } from './config/index.js';
import {
  createProductionObjectStoreObserver,
  ObservedS3Client,
  observePresign,
} from './s3/telemetry.js';
import type { ObjectStoreObserver } from './s3/telemetry.js';
import { sendS3 } from './s3/contract.js';

import { awaitWithSignal, requestSignal } from './s3/request-lifecycle.js';
import {
  createArtifactDownloadPresigner,
  signArtifactDownload,
  type ArtifactDownloadCapability,
  type BeginDirectDownloadRequest,
  type DirectDownload,
  type GetObjectPresigner,
} from './download.js';
import {
  assertWorkspaceVersionListing,
  validateWorkspaceVersionDeletion,
  workspaceVersionDeleteObjects,
} from './workspace-purge-validation.js';
import type {
  S3ClientLike,
  ArtifactMetadata,
  PutArtifactRequest,
  ArtifactRequest,
  ArtifactDownload,
  BeginDirectUploadRequest,
  ValidateDirectUploadRequest,
  DirectUpload,
  PutObjectPresigner,
  ArtifactStoreReadiness,
  ArtifactStore,
  PurgeWorkspaceObjectsRequest,
  WorkspaceObjectPurgePage,
  WorkspaceObjectPurgeStore,
} from './storage/contract.js';
import {
  purgeWorkspaceSchema,
  metadataSchema,
  beginDirectUploadSchema,
  DIRECT_UPLOAD_SIGNABLE_HEADERS,
  DIRECT_UPLOAD_UNHOISTABLE_HEADERS,
  workspacePrefix,
  isNotFound,
  objectMetadata,
  checksumSha256Base64,
  metadataFromHead,
  consume,
  destroyResponseBody,
} from './storage/metadata.js';
import { ObservedArtifactStore } from './storage/observed.js';
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
class AwsArtifactStore
  implements
    ArtifactStore,
    ArtifactDownloadCapability,
    WorkspaceObjectPurgeStore
{
  private closed = false;

  public constructor(
    private readonly config: ArtifactStoreConfig,
    private readonly client: S3ClientLike,
    private readonly presignPutObject: PutObjectPresigner,
    private readonly presignGetObject: GetObjectPresigner,
    private readonly ownsClient: boolean,
  ) {}

  public async beginDirectUpload(
    request: BeginDirectUploadRequest,
  ): Promise<DirectUpload> {
    this.assertOpen();
    const signal = requestSignal(this.config.requestTimeoutMs, request.signal);
    signal.throwIfAborted();
    const issuedAt = Date.now();
    const metadata = beginDirectUploadSchema.parse(request);
    this.assertWithinLimit(metadata);
    const checksum = checksumSha256Base64(metadata.sha256);
    const storedMetadata = objectMetadata(metadata);
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      ChecksumSHA256: checksum,
      ContentLength: metadata.byteLength,
      ContentType: metadata.mediaType,
      IfNoneMatch: '*',
      Key: artifactStorageKey(metadata),
      Metadata: storedMetadata,
    });
    const url = await awaitWithSignal(
      this.presignPutObject({
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

  public async beginDirectDownload(
    request: BeginDirectDownloadRequest,
  ): Promise<DirectDownload> {
    this.assertOpen();
    return signArtifactDownload(this.config, this.presignGetObject, request);
  }

  public async checkReadiness(
    signal?: AbortSignal,
  ): Promise<ArtifactStoreReadiness> {
    this.assertOpen();
    const options = {
      abortSignal: requestSignal(this.config.requestTimeoutMs, signal),
    };
    await sendS3(
      this.client,
      new HeadBucketCommand({ Bucket: this.config.bucket }),
      options,
    );
    const location = await sendS3(
      this.client,
      new GetBucketLocationCommand({ Bucket: this.config.bucket }),
      options,
    );
    const reportedRegion: string = location.LocationConstraint ?? '';
    const actualRegion =
      reportedRegion === '' || reportedRegion === 'null'
        ? 'us-east-1'
        : reportedRegion === 'EU'
          ? 'eu-west-1'
          : reportedRegion;
    if (actualRegion !== this.config.region)
      throw new ArtifactIntegrityError(
        'Artifact bucket region does not match the configured region',
      );
    return Object.freeze({
      bucket: this.config.bucket,
      region: actualRegion,
    });
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.ownsClient) this.client.destroy();
  }

  public async delete(request: ArtifactRequest): Promise<void> {
    this.assertOpen();
    const identity = artifactIdentitySchema.parse(request);
    await this.deleteIdentity(identity, request.signal);
  }

  public async getStream(request: ArtifactRequest): Promise<ArtifactDownload> {
    this.assertOpen();
    const identity = artifactIdentitySchema.parse(request);
    const signal = requestSignal(this.config.requestTimeoutMs, request.signal);
    return this.getVerifiedStream(identity, undefined, signal);
  }

  private async getVerifiedStream(
    identity: ArtifactIdentity,
    expected: ArtifactMetadata | undefined,
    signal: AbortSignal,
  ): Promise<ArtifactDownload> {
    let output: GetObjectCommandOutput;
    try {
      output = await sendS3(
        this.client,
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: artifactStorageKey(identity),
        }),
        {
          abortSignal: signal,
        },
      );
    } catch (error: unknown) {
      if (isNotFound(error)) {
        throw new ArtifactNotFoundError();
      }
      throw error;
    }

    if (!(output.Body instanceof Readable)) {
      destroyResponseBody(output.Body);
      throw new ArtifactIntegrityError(
        'Stored artifact body is not streamable',
      );
    }
    let metadata: ArtifactMetadata;
    try {
      metadata = metadataFromHead(identity, output, this.config.maxObjectBytes);
      if (
        expected !== undefined &&
        !artifactMetadataMatches(metadata, expected)
      ) {
        throw new ArtifactIntegrityError(
          'Stored artifact metadata does not match the expected upload',
        );
      }
    } catch (error: unknown) {
      output.Body.destroy();
      throw error;
    }
    return Object.freeze({
      body: verifiedBody(
        output.Body,
        expected ?? metadata,
        this.config.maxObjectBytes,
        'stored',
        signal,
      ),
      metadata,
    });
  }

  public async head(
    request: ArtifactRequest,
  ): Promise<ArtifactMetadata | null> {
    this.assertOpen();
    const identity = artifactIdentitySchema.parse(request);
    return this.headWithSignal(
      identity,
      requestSignal(this.config.requestTimeoutMs, request.signal),
    );
  }

  private async headWithSignal(
    identity: ArtifactIdentity,
    signal: AbortSignal,
  ): Promise<ArtifactMetadata | null> {
    try {
      const output = await sendS3(
        this.client,
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: artifactStorageKey(identity),
        }),
        { abortSignal: signal },
      );
      return metadataFromHead(identity, output, this.config.maxObjectBytes);
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  public async put(request: PutArtifactRequest): Promise<ArtifactMetadata> {
    this.assertOpen();
    const metadata = metadataSchema.parse(request);
    this.assertWithinLimit(metadata);

    const key = artifactStorageKey(metadata);
    const signal = requestSignal(this.config.requestTimeoutMs, request.signal);
    const body = verifiedBody(
      request.body,
      metadata,
      this.config.maxObjectBytes,
      'input',
      signal,
    );
    try {
      await sendS3(
        this.client,
        new PutObjectCommand({
          Body: body,
          Bucket: this.config.bucket,
          ChecksumSHA256: checksumSha256Base64(metadata.sha256),
          ContentLength: metadata.byteLength,
          ContentType: metadata.mediaType,
          IfNoneMatch: '*',
          Key: key,
          Metadata: objectMetadata(metadata),
        }),
        {
          abortSignal: signal,
        },
      );

      const verified = await this.headWithSignal(metadata, signal);
      if (verified === null) {
        throw new ArtifactIntegrityError('Uploaded artifact is unavailable');
      }
      if (!artifactMetadataMatches(verified, metadata)) {
        throw new ArtifactIntegrityError(
          'Uploaded artifact metadata does not match the requested artifact',
        );
      }
      return Object.freeze(metadata);
    } catch (error: unknown) {
      body.destroy();
      throw error;
    }
  }

  public async purgeWorkspacePage(
    request: PurgeWorkspaceObjectsRequest,
  ): Promise<WorkspaceObjectPurgePage> {
    this.assertOpen();
    const input = purgeWorkspaceSchema.parse(request);
    const prefix = workspacePrefix(input.workspaceId);
    const signal = requestSignal(this.config.requestTimeoutMs, request.signal);
    const listed = await sendS3(
      this.client,
      new ListObjectVersionsCommand({
        Bucket: this.config.bucket,
        MaxKeys: input.maxObjects,
        Prefix: prefix,
      }),
      { abortSignal: signal },
    );
    const entries = [
      ...(listed.Versions ?? []),
      ...(listed.DeleteMarkers ?? []),
    ];
    assertWorkspaceVersionListing(listed, entries, input.maxObjects);
    if (entries.length === 0) {
      return Object.freeze({ completed: true, deletedCount: 0 });
    }
    const seen = new Set<string>();
    const objects = workspaceVersionDeleteObjects(entries, prefix, seen);
    const deleted = await sendS3(
      this.client,
      new DeleteObjectsCommand({
        Bucket: this.config.bucket,
        Delete: { Objects: objects, Quiet: false },
      }),
      { abortSignal: signal },
    );
    const deletedCount = validateWorkspaceVersionDeletion(
      deleted,
      seen,
      objects.length,
    );
    return Object.freeze({
      completed: false,
      deletedCount,
    });
  }

  public async validateDirectUpload(
    request: ValidateDirectUploadRequest,
  ): Promise<ArtifactMetadata> {
    this.assertOpen();
    const expected = metadataSchema.parse(request);
    this.assertWithinLimit(expected);
    const signal = requestSignal(this.config.requestTimeoutMs, request.signal);
    let output: HeadObjectCommandOutput;
    try {
      output = await sendS3(
        this.client,
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          ChecksumMode: 'ENABLED',
          Key: artifactStorageKey(expected),
        }),
        { abortSignal: signal },
      );
    } catch (error: unknown) {
      if (isNotFound(error)) {
        throw new ArtifactNotFoundError();
      }
      throw error;
    }
    const actual = metadataFromHead(
      expected,
      output,
      this.config.maxObjectBytes,
    );
    if (!artifactMetadataMatches(actual, expected)) {
      throw new ArtifactIntegrityError(
        'Stored artifact metadata does not match the expected upload',
      );
    }

    if (output.ChecksumSHA256 !== undefined) {
      if (
        (output.ChecksumType !== undefined &&
          output.ChecksumType !== 'FULL_OBJECT') ||
        output.ChecksumSHA256 !== checksumSha256Base64(expected.sha256)
      ) {
        throw new ArtifactIntegrityError(
          'Stored artifact provider checksum is invalid',
        );
      }
      return Object.freeze(expected);
    }

    const download = await this.getVerifiedStream(expected, expected, signal);
    await consume(download.body);
    return Object.freeze(expected);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ArtifactStoreClosedError();
    }
  }

  private assertWithinLimit(metadata: ArtifactMetadata): void {
    if (metadata.byteLength > this.config.maxObjectBytes) {
      throw new ArtifactInputIntegrityError(
        'Artifact exceeds the configured limit',
      );
    }
  }

  private async deleteIdentity(
    identity: ArtifactIdentity,
    signal?: AbortSignal,
  ): Promise<void> {
    await sendS3(
      this.client,
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: artifactStorageKey(identity),
      }),
      { abortSignal: requestSignal(this.config.requestTimeoutMs, signal) },
    );
  }
}

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
  const store = new AwsArtifactStore(
    config,
    client,
    presignPutObject,
    createArtifactDownloadPresigner(
      rawClient as S3Client,
      observer,
      options.presignGetObject,
    ),
    ownsClient,
  );
  return new ObservedArtifactStore(store, observer);
}
