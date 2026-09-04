import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  DeleteObjectsCommandOutput,
  GetObjectCommandOutput,
  HeadObjectCommandOutput,
  ListObjectVersionsCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { z } from 'zod';

import { artifactMetadataMatches } from './artifact-metadata.js';
import type { ArtifactStoreConfig } from './config.js';
import {
  createProductionObjectStoreObserver,
  ObservedS3Client,
  observePresign,
  safelyObserveSafetyViolation,
} from './object-store-telemetry.js';
import type {
  ObjectStoreObserver,
  ObjectStoreRegionRole,
} from './object-store-telemetry.js';

type S3Command =
  | DeleteObjectCommand
  | DeleteObjectsCommand
  | GetObjectCommand
  | HeadBucketCommand
  | HeadObjectCommand
  | ListObjectVersionsCommand
  | PutObjectCommand;

export interface S3ClientLike {
  destroy(): void;
  send(
    command: S3Command,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<unknown>;
}

export interface ArtifactIdentity {
  readonly artifactId: string;
  readonly workspaceId: string;
}

export interface ArtifactMetadata extends ArtifactIdentity {
  readonly byteLength: number;
  readonly mediaType: string;
  readonly sha256: string;
}

export interface PutArtifactRequest extends ArtifactMetadata {
  readonly body: Readable;
  readonly signal?: AbortSignal;
}

export interface ArtifactRequest extends ArtifactIdentity {
  readonly signal?: AbortSignal;
}

export interface ArtifactDownload {
  readonly body: Readable;
  readonly metadata: ArtifactMetadata;
}

export interface BeginDirectUploadRequest extends ArtifactMetadata {
  readonly expiresInSeconds: number;
  readonly signal?: AbortSignal;
}

export interface ValidateDirectUploadRequest extends ArtifactMetadata {
  readonly signal?: AbortSignal;
}

export interface DirectUpload {
  readonly expiresAt: string;
  readonly expiresInSeconds: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: 'PUT';
  readonly url: string;
}

export interface PutObjectPresignRequest {
  readonly command: PutObjectCommand;
  readonly expiresInSeconds: number;
  readonly signal: AbortSignal;
  readonly signableHeaders: ReadonlySet<string>;
  readonly unhoistableHeaders: ReadonlySet<string>;
}

export type PutObjectPresigner = (
  request: PutObjectPresignRequest,
) => Promise<string>;

export interface ArtifactStoreReadiness {
  readonly bucket: string;
  readonly region: string;
}

export interface ArtifactStore {
  beginDirectUpload(request: BeginDirectUploadRequest): Promise<DirectUpload>;
  checkReadiness(signal?: AbortSignal): Promise<ArtifactStoreReadiness>;
  close(): void;
  delete(request: ArtifactRequest): Promise<void>;
  getStream(request: ArtifactRequest): Promise<ArtifactDownload>;
  head(request: ArtifactRequest): Promise<ArtifactMetadata | null>;
  put(request: PutArtifactRequest): Promise<ArtifactMetadata>;
  validateDirectUpload(
    request: ValidateDirectUploadRequest,
  ): Promise<ArtifactMetadata>;
}

export interface PurgeWorkspaceObjectsRequest {
  readonly maxObjects: number;
  readonly signal?: AbortSignal;
  readonly workspaceId: string;
}

export interface WorkspaceObjectPurgePage {
  readonly completed: boolean;
  readonly deletedCount: number;
}

export interface WorkspaceObjectPurgeStore {
  purgeWorkspacePage(
    request: PurgeWorkspaceObjectsRequest,
  ): Promise<WorkspaceObjectPurgePage>;
}

export class ArtifactIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArtifactIntegrityError';
  }
}

class ArtifactInputIntegrityError extends ArtifactIntegrityError {}

export class ArtifactNotFoundError extends Error {
  public constructor() {
    super('Artifact was not found');
    this.name = 'ArtifactNotFoundError';
  }
}

export class ArtifactStoreClosedError extends Error {
  public constructor() {
    super('Artifact store is closed');
    this.name = 'ArtifactStoreClosedError';
  }
}

const identitySchema = z.object({
  artifactId: z.uuid(),
  workspaceId: z.uuid(),
});

const purgeWorkspaceSchema = z.object({
  maxObjects: z.number().int().min(1).max(500),
  workspaceId: z.uuid(),
});

const metadataSchema = identitySchema.extend({
  byteLength: z.number().int().nonnegative(),
  mediaType: z
    .string()
    .trim()
    .min(3)
    .max(255)
    .regex(/^[^\s/;]+\/[^\r\n]+$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const beginDirectUploadSchema = metadataSchema.extend({
  expiresInSeconds: z.number().int().min(60).max(900),
});

const STORAGE_METADATA = {
  artifactId: 'artifact-id',
  byteLength: 'byte-length',
  mediaType: 'media-type',
  sha256: 'sha256',
  workspaceId: 'workspace-id',
} as const;

const USER_METADATA_KEYS = Object.values(STORAGE_METADATA).toSorted();
const DIRECT_UPLOAD_SIGNABLE_HEADERS = new Set([
  'content-length',
  'content-type',
  'if-none-match',
]);
const DIRECT_UPLOAD_UNHOISTABLE_HEADERS = new Set([
  'x-amz-checksum-sha256',
  ...USER_METADATA_KEYS.map((key) => `x-amz-meta-${key}`),
]);

function storageKey(identity: ArtifactIdentity): string {
  return `workspaces/${identity.workspaceId}/artifacts/${identity.artifactId}`;
}

function workspacePrefix(workspaceId: string): string {
  return `workspaces/${workspaceId}/`;
}

function requestSignal(
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return externalSignal === undefined
    ? timeoutSignal
    : AbortSignal.any([externalSignal, timeoutSignal]);
}

function awaitWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error
          ? reason
          : new Error('Artifact operation aborted', { cause: reason }),
      );
    };
    signal.addEventListener('abort', aborted, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(
          error instanceof Error
            ? error
            : new Error('Artifact operation failed', { cause: error }),
        );
      },
    );
  });
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as {
    readonly $metadata?: { readonly httpStatusCode?: number };
    readonly name?: string;
  };
  return (
    candidate.$metadata?.httpStatusCode === 404 ||
    candidate.name === 'NoSuchKey' ||
    candidate.name === 'NotFound'
  );
}

function objectMetadata(
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

function checksumSha256Base64(sha256: string): string {
  return Buffer.from(sha256, 'hex').toString('base64');
}

function metadataFromHead(
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

  if (
    !candidate.success ||
    metadataKeys.length !== USER_METADATA_KEYS.length ||
    metadataKeys.some((key, index) => key !== USER_METADATA_KEYS[index]) ||
    candidate.data.artifactId !== identity.artifactId ||
    candidate.data.workspaceId !== identity.workspaceId ||
    candidate.data.byteLength > maxObjectBytes ||
    output.ContentLength !== candidate.data.byteLength ||
    storedContentType !== candidate.data.mediaType.replace(/\s*;\s*/gu, ';')
  ) {
    throw new ArtifactIntegrityError('Stored artifact metadata is invalid');
  }

  return Object.freeze(candidate.data);
}

class VerifyingTransform extends Transform {
  private readonly hash = createHash('sha256');
  private bytesSeen = 0;

  public constructor(
    private readonly expectedBytes: number,
    private readonly expectedSha256: string,
    private readonly maximumBytes: number,
    private readonly source: 'input' | 'stored',
  ) {
    super();
  }

  public override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk, encoding);
    this.bytesSeen += buffer.byteLength;
    if (
      this.bytesSeen > this.expectedBytes ||
      this.bytesSeen > this.maximumBytes
    ) {
      callback(this.integrityError('Artifact body exceeds its bound'));
      return;
    }

    this.hash.update(buffer);
    callback(null, buffer);
  }

  public override _flush(callback: TransformCallback): void {
    const actualSha256 = this.hash.digest('hex');
    if (
      this.bytesSeen !== this.expectedBytes ||
      actualSha256 !== this.expectedSha256
    ) {
      callback(
        this.integrityError(
          'Artifact body does not match its declared length and SHA-256',
        ),
      );
      return;
    }
    callback();
  }

  private integrityError(message: string): ArtifactIntegrityError {
    return this.source === 'input'
      ? new ArtifactInputIntegrityError(message)
      : new ArtifactIntegrityError(message);
  }
}

function verifiedBody(
  body: Readable,
  metadata: ArtifactMetadata,
  maxObjectBytes: number,
  source: 'input' | 'stored',
  signal?: AbortSignal,
): Readable {
  const verifier = new VerifyingTransform(
    metadata.byteLength,
    metadata.sha256,
    maxObjectBytes,
    source,
  );
  body.once('error', (error: Error) => {
    verifier.destroy(error);
  });
  const abort = (): void => {
    verifier.destroy(abortError(signal));
  };
  if (signal !== undefined) {
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
  }
  verifier.once('close', () => {
    signal?.removeEventListener('abort', abort);
    if (!body.destroyed) {
      body.destroy();
    }
  });
  return body.pipe(verifier);
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error
    ? reason
    : new Error('Artifact transfer aborted');
}

async function consume(body: Readable): Promise<void> {
  for await (const chunk of body) {
    // Integrity is enforced by the verifier while bytes are discarded.
    void chunk;
  }
}

function destroyResponseBody(body: unknown): void {
  if (isDestroyable(body)) {
    body.destroy();
  }
}

interface Destroyable {
  destroy(): void;
}

function isDestroyable(value: unknown): value is Destroyable {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { readonly destroy?: unknown };
  return typeof candidate.destroy === 'function';
}

class AwsArtifactStore implements ArtifactStore, WorkspaceObjectPurgeStore {
  private closed = false;

  public constructor(
    private readonly config: ArtifactStoreConfig,
    private readonly client: S3ClientLike,
    private readonly presignPutObject: PutObjectPresigner,
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
      Key: storageKey(metadata),
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

  public async checkReadiness(
    signal?: AbortSignal,
  ): Promise<ArtifactStoreReadiness> {
    this.assertOpen();
    await this.client.send(
      new HeadBucketCommand({ Bucket: this.config.bucket }),
      { abortSignal: requestSignal(this.config.requestTimeoutMs, signal) },
    );
    return Object.freeze({
      bucket: this.config.bucket,
      region: this.config.region,
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
    const identity = identitySchema.parse(request);
    await this.deleteIdentity(identity, request.signal);
  }

  public async getStream(request: ArtifactRequest): Promise<ArtifactDownload> {
    this.assertOpen();
    const identity = identitySchema.parse(request);
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
      output = (await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: storageKey(identity),
        }),
        {
          abortSignal: signal,
        },
      )) as GetObjectCommandOutput;
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
    const identity = identitySchema.parse(request);
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
      const output = (await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: storageKey(identity),
        }),
        { abortSignal: signal },
      )) as HeadObjectCommandOutput;
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

    const key = storageKey(metadata);
    const signal = requestSignal(this.config.requestTimeoutMs, request.signal);
    const body = verifiedBody(
      request.body,
      metadata,
      this.config.maxObjectBytes,
      'input',
      signal,
    );
    try {
      await this.client.send(
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
      return verified;
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
    const listed = (await this.client.send(
      new ListObjectVersionsCommand({
        Bucket: this.config.bucket,
        MaxKeys: input.maxObjects,
        Prefix: prefix,
      }),
      { abortSignal: signal },
    )) as ListObjectVersionsCommandOutput;
    const entries = [
      ...(listed.Versions ?? []),
      ...(listed.DeleteMarkers ?? []),
    ];
    if (entries.length > input.maxObjects) {
      throw new ArtifactIntegrityError(
        'Object version listing exceeded the requested page bound',
      );
    }
    if (entries.length === 0) {
      if (listed.IsTruncated === true) {
        throw new ArtifactIntegrityError(
          'Object version listing was truncated without entries',
        );
      }
      return Object.freeze({ completed: true, deletedCount: 0 });
    }
    const seen = new Set<string>();
    const objects = entries.map((entry) => {
      if (
        typeof entry.Key !== 'string' ||
        !entry.Key.startsWith(prefix) ||
        typeof entry.VersionId !== 'string' ||
        entry.VersionId.length === 0
      ) {
        throw new ArtifactIntegrityError(
          'Object version listing contained an invalid workspace entry',
        );
      }
      const identity = `${entry.Key}\u0000${entry.VersionId}`;
      if (seen.has(identity)) {
        throw new ArtifactIntegrityError(
          'Object version listing contained a duplicate entry',
        );
      }
      seen.add(identity);
      return { Key: entry.Key, VersionId: entry.VersionId };
    });
    const deleted = (await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.config.bucket,
        Delete: { Objects: objects, Quiet: false },
      }),
      { abortSignal: signal },
    )) as DeleteObjectsCommandOutput;
    if ((deleted.Errors?.length ?? 0) > 0) {
      throw new ArtifactIntegrityError(
        'Object version deletion reported one or more failures',
      );
    }
    return Object.freeze({
      completed: false,
      deletedCount: objects.length,
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
      output = (await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          ChecksumMode: 'ENABLED',
          Key: storageKey(expected),
        }),
        { abortSignal: signal },
      )) as HeadObjectCommandOutput;
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
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: storageKey(identity),
      }),
      { abortSignal: requestSignal(this.config.requestTimeoutMs, signal) },
    );
  }
}

class ObservedArtifactStore
  implements ArtifactStore, WorkspaceObjectPurgeStore
{
  public constructor(
    private readonly store: ArtifactStore & WorkspaceObjectPurgeStore,
    private readonly observer: ObjectStoreObserver,
    private readonly regionRole: ObjectStoreRegionRole,
  ) {}

  public beginDirectUpload(
    request: BeginDirectUploadRequest,
  ): Promise<DirectUpload> {
    return this.observe(() => this.store.beginDirectUpload(request));
  }

  public checkReadiness(signal?: AbortSignal): Promise<ArtifactStoreReadiness> {
    return this.observe(() => this.store.checkReadiness(signal));
  }

  public close(): void {
    this.store.close();
  }

  public delete(request: ArtifactRequest): Promise<void> {
    return this.observe(() => this.store.delete(request));
  }

  public async getStream(request: ArtifactRequest): Promise<ArtifactDownload> {
    const download = await this.observe(() => this.store.getStream(request));
    download.body.once('error', (error: unknown) => {
      this.report(error);
    });
    return download;
  }

  public head(request: ArtifactRequest): Promise<ArtifactMetadata | null> {
    return this.observe(() => this.store.head(request));
  }

  public put(request: PutArtifactRequest): Promise<ArtifactMetadata> {
    return this.observe(() => this.store.put(request));
  }

  public purgeWorkspacePage(
    request: PurgeWorkspaceObjectsRequest,
  ): Promise<WorkspaceObjectPurgePage> {
    return this.observe(() => this.store.purgeWorkspacePage(request));
  }

  public validateDirectUpload(
    request: ValidateDirectUploadRequest,
  ): Promise<ArtifactMetadata> {
    return this.observe(() => this.store.validateDirectUpload(request));
  }

  private async observe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      this.report(error);
      throw error;
    }
  }

  private report(error: unknown): void {
    if (
      !(error instanceof ArtifactIntegrityError) ||
      error instanceof ArtifactInputIntegrityError
    )
      return;
    safelyObserveSafetyViolation(this.observer, {
      check: 'artifact_integrity',
      regionRole: this.regionRole,
      surface: 'artifact',
    });
  }
}

export function createArtifactStore(
  config: ArtifactStoreConfig,
  options: Readonly<{
    client?: S3ClientLike;
    clientOwnership?: 'borrowed' | 'owned';
    observer?: ObjectStoreObserver;
    presignPutObject?: PutObjectPresigner;
    regionRole?: ObjectStoreRegionRole;
  }> = {},
): ArtifactStore & WorkspaceObjectPurgeStore {
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
  const regionRole = options.regionRole ?? 'artifact';
  const ownsClient =
    options.client === undefined || options.clientOwnership === 'owned';
  const client = new ObservedS3Client(
    rawClient,
    observer,
    'artifact',
    regionRole,
  );
  const rawPresignPutObject: PutObjectPresigner =
    options.presignPutObject ??
    (async (request) =>
      getSignedUrl(rawClient as S3Client, request.command, {
        expiresIn: request.expiresInSeconds,
        signableHeaders: new Set(request.signableHeaders),
        unhoistableHeaders: new Set(request.unhoistableHeaders),
      }));
  const presignPutObject: PutObjectPresigner = (request) =>
    observePresign(observer, regionRole, () => rawPresignPutObject(request));
  const store = new AwsArtifactStore(
    config,
    client,
    presignPutObject,
    ownsClient,
  );
  return new ObservedArtifactStore(store, observer, regionRole);
}
