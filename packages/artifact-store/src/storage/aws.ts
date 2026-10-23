import {
  DeleteObjectCommand,
  GetBucketLocationCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { HeadObjectCommandOutput } from '@aws-sdk/client-s3';

import { verifiedBody } from '../stream-verification.js';
import { artifactMetadataMatches } from '../metadata.js';
import {
  artifactIdentitySchema,
  artifactStorageKey,
  type ArtifactIdentity,
} from '../identity.js';
import {
  ArtifactInputIntegrityError,
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  ArtifactStoreClosedError,
} from '../errors.js';
import type { ArtifactStoreConfig } from '../config/index.js';

import { sendS3 } from '../s3/contract.js';
import { requestSignal } from '../s3/request-lifecycle.js';
import {
  signArtifactDownload,
  type ArtifactDownloadCapability,
  type BeginDirectDownloadRequest,
  type DirectDownload,
  type GetObjectPresigner,
} from '../download.js';

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
} from './contract.js';
import {
  metadataSchema,
  beginDirectUploadSchema,
  isNotFound,
  objectMetadata,
  checksumSha256Base64,
  metadataFromHead,
  consume,
} from './metadata.js';

import { readVerifiedArtifact } from './read.js';
import { signArtifactUpload } from './sign-upload.js';
import { purgeWorkspaceObjects } from './purge.js';

const BUCKET_REGION_ALIASES = new Map([
  ['', 'us-east-1'],
  ['null', 'us-east-1'],
  ['EU', 'eu-west-1'],
]);

export class AwsArtifactStore
  implements
    ArtifactStore,
    ArtifactDownloadCapability,
    WorkspaceObjectPurgeStore
{
  private closed = false;

  private readonly config: ArtifactStoreConfig;
  private readonly client: S3ClientLike;
  private readonly presignPutObject: PutObjectPresigner;
  private readonly presignGetObject: GetObjectPresigner;
  private readonly ownsClient: boolean;

  public constructor(
    options: Readonly<{
      config: ArtifactStoreConfig;
      client: S3ClientLike;
      presignPutObject: PutObjectPresigner;
      presignGetObject: GetObjectPresigner;
      ownsClient: boolean;
    }>,
  ) {
    this.config = options.config;
    this.client = options.client;
    this.presignPutObject = options.presignPutObject;
    this.presignGetObject = options.presignGetObject;
    this.ownsClient = options.ownsClient;
  }

  public async beginDirectUpload(
    request: BeginDirectUploadRequest,
  ): Promise<DirectUpload> {
    this.assertOpen();
    const signal = requestSignal(this.config.requestTimeoutMs, request.signal);
    signal.throwIfAborted();
    const issuedAt = Date.now();
    const metadata = beginDirectUploadSchema.parse(request);
    this.assertWithinLimit(metadata);
    return signArtifactUpload({
      config: this.config,
      presignPutObject: this.presignPutObject,
      metadata,
      signal,
      issuedAt,
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
      BUCKET_REGION_ALIASES.get(reportedRegion) ?? reportedRegion;
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
    return readVerifiedArtifact({
      client: this.client,
      config: this.config,
      identity,
      expected: undefined,
      signal,
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
    const body = verifiedBody(request.body, {
      metadata: metadata,
      maxObjectBytes: this.config.maxObjectBytes,
      source: 'input',
      signal: signal,
    });
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
    return purgeWorkspaceObjects(
      { config: this.config, client: this.client },
      request,
    );
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

    const download = await readVerifiedArtifact({
      client: this.client,
      config: this.config,
      identity: expected,
      expected,
      signal,
    });
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
