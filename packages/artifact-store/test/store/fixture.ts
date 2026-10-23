import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  GetBucketLocationCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

import { createArtifactStore } from '../../src/store.js';

import type { S3ClientLike } from '../../src/store.js';
import type { PutObjectPresignRequest } from '../../src/store.js';
import type { GetObjectPresignRequest } from '../../src/download.js';

export const WORKSPACE_ID = '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c01';

export const ARTIFACT_ID = '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c02';

export const HELLO_SHA256 =
  '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

const USE_STORED_BODY = Symbol('use-stored-body');

interface StoredObject {
  readonly body: Buffer;
  readonly checksumSha256?: string;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
}

async function bufferBody(body: unknown): Promise<Buffer> {
  if (
    typeof body !== 'object' ||
    body === null ||
    !(Symbol.asyncIterator in body)
  ) {
    throw new Error('Expected an async iterable body');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<unknown>) {
    if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
    } else {
      throw new Error('Unsupported body chunk');
    }
  }
  return Buffer.concat(chunks);
}

export class MemoryS3Client implements S3ClientLike {
  private readonly objects = new Map<string, StoredObject>();
  public readonly commands: unknown[] = [];
  public ambiguousPutFailure: Error | undefined;
  public destroyCalls = 0;
  public deleteVersionsErrors:
    | readonly Readonly<{ Code: string; Key: string; VersionId: string }>[]
    | undefined;
  public deleteVersionsAcknowledgements:
    readonly Readonly<{ Key?: string; VersionId?: string }>[] | undefined;
  public deletedVersions:
    | readonly Readonly<{
        Key?: string | undefined;
        VersionId?: string | undefined;
      }>[]
    | undefined;
  public hangReadiness = false;
  public locationConstraint: string | null = null;
  public hangHead = false;
  public lastGetBody: Readable | undefined;
  public getCalls = 0;
  public provideProviderChecksum = true;
  public checksumSha256Override: string | undefined;
  public checksumTypeOverride: string | undefined;
  public contentLengthOverride: number | undefined;
  public contentTypeOverride: string | undefined;
  public headMetadataOverride: Readonly<Record<string, string>> | undefined;
  public putFailureAfterStore: Error | undefined;
  public nextHeadNotFound = false;
  public versionListOutput: unknown = {};
  public versionListInput:
    | Readonly<{
        MaxKeys?: number | undefined;
        Prefix?: string | undefined;
      }>
    | undefined;
  public useInvalidHeadMetadata = false;
  public useInvalidGetMetadata = false;
  public getBodyFactory: ((object: StoredObject) => Readable) | undefined;
  public getBodyOverride: unknown = USE_STORED_BODY;
  public getError: Error | undefined;
  public getMetadataOverride: Readonly<Record<string, string>> | undefined;
  public headError: Error | undefined;

  public async send(
    command: unknown,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<unknown> {
    this.commands.push(command);
    if (command instanceof PutObjectCommand) {
      return this.putObject(command);
    }
    if (command instanceof HeadObjectCommand) {
      return this.headObject(command, options);
    }
    if (command instanceof GetObjectCommand) {
      return this.getObject(command);
    }
    if (command instanceof DeleteObjectCommand) {
      return this.deleteObject(command);
    }
    if (command instanceof ListObjectVersionsCommand) {
      return this.listObjectVersions(command);
    }
    if (command instanceof DeleteObjectsCommand) {
      return this.deleteObjects(command);
    }
    if (command instanceof HeadBucketCommand) {
      return this.headBucket(command, options);
    }
    if (command instanceof GetBucketLocationCommand)
      return { LocationConstraint: this.locationConstraint };
    throw new Error('Unsupported S3 command');
  }
  private async putObject(command: PutObjectCommand): Promise<unknown> {
    if (this.ambiguousPutFailure !== undefined) {
      throw this.ambiguousPutFailure;
    }
    const key = String(command.input.Key);
    if (command.input.IfNoneMatch === '*' && this.objects.has(key)) {
      throw Object.assign(new Error('Precondition failed'), {
        $metadata: { httpStatusCode: 412 },
        name: 'PreconditionFailed',
      });
    }
    const body = await bufferBody(command.input.Body);
    this.objects.set(key, {
      body,
      ...(command.input.ChecksumSHA256 === undefined
        ? {}
        : { checksumSha256: command.input.ChecksumSHA256 }),
      contentType: String(command.input.ContentType),
      metadata: { ...command.input.Metadata },
    });
    if (this.putFailureAfterStore !== undefined) {
      throw this.putFailureAfterStore;
    }
    return {};
  }

  private async headObject(
    command: HeadObjectCommand,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<unknown> {
    if (this.headError !== undefined) throw this.headError;
    if (this.nextHeadNotFound) {
      this.nextHeadNotFound = false;
      throw Object.assign(new Error('Not found'), {
        $metadata: { httpStatusCode: 404 },
        name: 'NotFound',
      });
    }
    if (this.hangHead)
      await new Promise<never>((_resolve, reject) => {
        const abort = () => {
          const reason: unknown = options?.abortSignal?.reason;
          reject(
            reason instanceof Error
              ? reason
              : new Error('Head request aborted', { cause: reason }),
          );
        };
        if (options?.abortSignal?.aborted === true) abort();
        else
          options?.abortSignal?.addEventListener('abort', abort, {
            once: true,
          });
      });
    const object = this.object(String(command.input.Key));
    return {
      ChecksumSHA256: this.provideProviderChecksum
        ? (this.checksumSha256Override ?? object.checksumSha256)
        : undefined,
      ChecksumType:
        object.checksumSha256 === undefined
          ? undefined
          : (this.checksumTypeOverride ?? 'FULL_OBJECT'),
      ContentLength: this.contentLengthOverride ?? object.body.byteLength,
      ContentType: this.contentTypeOverride ?? object.contentType,
      ETag: 'etag-is-not-a-checksum',
      Metadata: this.useInvalidHeadMetadata
        ? {}
        : (this.headMetadataOverride ?? object.metadata),
    };
  }

  private getObject(command: GetObjectCommand): unknown {
    this.getCalls += 1;
    if (this.getError !== undefined) throw this.getError;
    const object = this.object(String(command.input.Key));
    const body = this.getBodyFactory?.(object) ?? Readable.from([object.body]);
    this.lastGetBody = body;
    return {
      Body:
        this.getBodyOverride === USE_STORED_BODY ? body : this.getBodyOverride,
      ContentLength: object.body.byteLength,
      ContentType: object.contentType,
      ETag: 'etag-is-not-a-checksum',
      Metadata: this.useInvalidGetMetadata
        ? {}
        : (this.getMetadataOverride ?? object.metadata),
    };
  }

  private deleteObject(command: DeleteObjectCommand): unknown {
    this.objects.delete(String(command.input.Key));
    return {};
  }

  private listObjectVersions(command: ListObjectVersionsCommand): unknown {
    this.versionListInput = command.input;
    return this.versionListOutput;
  }

  private deleteObjects(command: DeleteObjectsCommand): unknown {
    this.deletedVersions = command.input.Delete?.Objects;
    return {
      Deleted:
        this.deleteVersionsAcknowledgements ?? command.input.Delete?.Objects,
      Errors: this.deleteVersionsErrors,
    };
  }

  private async headBucket(
    command: HeadBucketCommand,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<unknown> {
    if (this.hangReadiness) {
      await new Promise<never>((_resolve, reject) => {
        options?.abortSignal?.addEventListener(
          'abort',
          () => {
            const reason: unknown = options.abortSignal?.reason;
            reject(
              reason instanceof Error ? reason : new Error('Readiness aborted'),
            );
          },
          { once: true },
        );
      });
    }
    return {};
  }

  public destroy(): void {
    this.destroyCalls += 1;
  }

  public corrupt(identity: {
    readonly artifactId: string;
    readonly workspaceId: string;
  }): void {
    const key = `workspaces/${identity.workspaceId}/artifacts/${identity.artifactId}`;
    const object = this.object(key);
    this.objects.set(key, { ...object, body: Buffer.from('HELLO') });
  }

  private object(key: string): StoredObject {
    const object = this.objects.get(key);
    if (object === undefined) {
      throw Object.assign(new Error('Not found'), {
        $metadata: { httpStatusCode: 404 },
        name: 'NotFound',
      });
    }
    return object;
  }
}

export function createStore(client = new MemoryS3Client()) {
  let presignRequest: PutObjectPresignRequest | undefined;
  let presignGetRequest: GetObjectPresignRequest | undefined;
  return {
    client,
    get presignRequest() {
      return presignRequest;
    },
    get presignGetRequest() {
      return presignGetRequest;
    },
    store: createArtifactStore(
      {
        accessKeyId: 'access',
        bucket: 'pertexo-artifacts',
        endpoint: 'http://localhost:9090',
        forcePathStyle: true,
        maxObjectBytes: 10 * 1024 * 1024,
        region: 'us-east-1',
        requestTimeoutMs: 100,
        secretAccessKey: 'secret',
      },
      {
        client,
        clientOwnership: 'owned',
        presignGetObject: (request) => {
          presignGetRequest = request;
          return Promise.resolve('https://downloads.example.test/signed');
        },
        presignPutObject: (request) => {
          presignRequest = request;
          return Promise.resolve('https://uploads.example.test/signed');
        },
      },
    ),
  };
}

export async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}
