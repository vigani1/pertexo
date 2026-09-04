import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createArtifactStore } from '../src/store.js';
import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  ArtifactStoreClosedError,
} from '../src/store.js';
import type { S3ClientLike } from '../src/store.js';
import type { PutObjectPresignRequest } from '../src/store.js';

const WORKSPACE_ID = '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c01';
const ARTIFACT_ID = '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c02';
const HELLO_SHA256 =
  '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

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

class MemoryS3Client implements S3ClientLike {
  private readonly objects = new Map<string, StoredObject>();
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
  public hangHead = false;
  public lastGetBody: Readable | undefined;
  public getCalls = 0;
  public provideProviderChecksum = true;
  public putFailureAfterStore: Error | undefined;
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

  public async send(
    command: unknown,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
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
    if (command instanceof HeadObjectCommand) {
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
          ? object.checksumSha256
          : undefined,
        ChecksumType:
          object.checksumSha256 === undefined ? undefined : 'FULL_OBJECT',
        ContentLength: object.body.byteLength,
        ContentType: object.contentType,
        ETag: 'etag-is-not-a-checksum',
        Metadata: this.useInvalidHeadMetadata ? {} : object.metadata,
      };
    }
    if (command instanceof GetObjectCommand) {
      this.getCalls += 1;
      const object = this.object(String(command.input.Key));
      const body =
        this.getBodyFactory?.(object) ?? Readable.from([object.body]);
      this.lastGetBody = body;
      return {
        Body: body,
        ContentLength: object.body.byteLength,
        ContentType: object.contentType,
        ETag: 'etag-is-not-a-checksum',
        Metadata: this.useInvalidGetMetadata ? {} : object.metadata,
      };
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(String(command.input.Key));
      return {};
    }
    if (command instanceof ListObjectVersionsCommand) {
      this.versionListInput = command.input;
      return this.versionListOutput;
    }
    if (command instanceof DeleteObjectsCommand) {
      this.deletedVersions = command.input.Delete?.Objects;
      return {
        Deleted:
          this.deleteVersionsAcknowledgements ?? command.input.Delete?.Objects,
        Errors: this.deleteVersionsErrors,
      };
    }
    if (command instanceof HeadBucketCommand) {
      if (this.hangReadiness) {
        await new Promise<never>((_resolve, reject) => {
          options?.abortSignal?.addEventListener(
            'abort',
            () => {
              const reason: unknown = options.abortSignal?.reason;
              reject(
                reason instanceof Error
                  ? reason
                  : new Error('Readiness aborted'),
              );
            },
            { once: true },
          );
        });
      }
      return {};
    }
    throw new Error('Unsupported S3 command');
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

function createStore(client = new MemoryS3Client()) {
  let presignRequest: PutObjectPresignRequest | undefined;
  return {
    client,
    get presignRequest() {
      return presignRequest;
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
        presignPutObject: (request) => {
          presignRequest = request;
          return Promise.resolve('https://uploads.example.test/signed');
        },
      },
    ),
  };
}

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

describe('ArtifactStore', () => {
  it('stores and streams a workspace artifact with verified metadata', async () => {
    const { store } = createStore();
    const stored = await store.put({
      artifactId: ARTIFACT_ID,
      body: Readable.from(['hello']),
      byteLength: 5,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      workspaceId: WORKSPACE_ID,
    });

    expect(stored).toEqual({
      artifactId: ARTIFACT_ID,
      byteLength: 5,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      workspaceId: WORKSPACE_ID,
    });
    await expect(
      store.head({ artifactId: ARTIFACT_ID, workspaceId: WORKSPACE_ID }),
    ).resolves.toEqual(stored);

    const downloaded = await store.getStream({
      artifactId: ARTIFACT_ID,
      workspaceId: WORKSPACE_ID,
    });
    await expect(readAll(downloaded.body)).resolves.toEqual(
      Buffer.from('hello'),
    );
    expect(downloaded.metadata).toEqual(stored);
  });

  it('rejects oversized declarations without storing an object', async () => {
    const { store } = createStore();

    await expect(
      store.put({
        artifactId: ARTIFACT_ID,
        body: Readable.from(['hello']),
        byteLength: 10 * 1024 * 1024 + 1,
        mediaType: 'text/plain',
        sha256: HELLO_SHA256,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
    await expect(
      store.head({ artifactId: ARTIFACT_ID, workspaceId: WORKSPACE_ID }),
    ).resolves.toBeNull();
  });

  it.each([
    { body: 'hell', byteLength: 5, sha256: HELLO_SHA256 },
    { body: 'hello!', byteLength: 5, sha256: HELLO_SHA256 },
    { body: 'hello', byteLength: 5, sha256: '0'.repeat(64) },
  ])(
    'rejects a body outside its declared integrity bound %#',
    async (input) => {
      const { store } = createStore();

      await expect(
        store.put({
          artifactId: ARTIFACT_ID,
          body: Readable.from([input.body]),
          byteLength: input.byteLength,
          mediaType: 'text/plain',
          sha256: input.sha256,
          workspaceId: WORKSPACE_ID,
        }),
      ).rejects.toBeInstanceOf(ArtifactIntegrityError);
      await expect(
        store.head({ artifactId: ARTIFACT_ID, workspaceId: WORKSPACE_ID }),
      ).resolves.toBeNull();
    },
  );

  it('does not delete an existing immutable artifact after an ambiguous put failure', async () => {
    const { client, store } = createStore();
    await store.put({
      artifactId: ARTIFACT_ID,
      body: Readable.from(['hello']),
      byteLength: 5,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      workspaceId: WORKSPACE_ID,
    });
    client.ambiguousPutFailure = new Error('request timed out after dispatch');

    await expect(
      store.put({
        artifactId: ARTIFACT_ID,
        body: Readable.from(['world']),
        byteLength: 5,
        mediaType: 'text/plain',
        sha256:
          '486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7',
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow('request timed out after dispatch');

    client.ambiguousPutFailure = undefined;
    const existing = await store.getStream({
      artifactId: ARTIFACT_ID,
      workspaceId: WORKSPACE_ID,
    });
    await expect(readAll(existing.body)).resolves.toEqual(Buffer.from('hello'));
  });

  it('retains an ambiguously committed upload for lifecycle cleanup', async () => {
    const { client, store } = createStore();
    client.putFailureAfterStore = new Error('response was lost');

    await expect(
      store.put({
        artifactId: ARTIFACT_ID,
        body: Readable.from(['hello']),
        byteLength: 5,
        mediaType: 'text/plain',
        sha256: HELLO_SHA256,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow('response was lost');

    client.putFailureAfterStore = undefined;
    await expect(
      store.head({ artifactId: ARTIFACT_ID, workspaceId: WORKSPACE_ID }),
    ).resolves.toMatchObject({ sha256: HELLO_SHA256 });
  });

  it('retains a successfully uploaded object when post-upload verification fails', async () => {
    const { client, store } = createStore();
    client.useInvalidHeadMetadata = true;

    await expect(
      store.put({
        artifactId: ARTIFACT_ID,
        body: Readable.from(['hello']),
        byteLength: 5,
        mediaType: 'text/plain',
        sha256: HELLO_SHA256,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);

    client.useInvalidHeadMetadata = false;
    await expect(
      store.head({ artifactId: ARTIFACT_ID, workspaceId: WORKSPACE_ID }),
    ).resolves.toMatchObject({ sha256: HELLO_SHA256 });
  });

  it('presigns an immutable, checksum-bound, workspace-scoped direct upload', async () => {
    const fixture = createStore();
    const upload = await fixture.store.beginDirectUpload({
      artifactId: ARTIFACT_ID,
      byteLength: 5,
      expiresInSeconds: 300,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      workspaceId: WORKSPACE_ID,
    });

    expect(upload).toMatchObject({
      expiresInSeconds: 300,
      headers: {
        'content-length': '5',
        'content-type': 'text/plain',
        'if-none-match': '*',
        'x-amz-checksum-sha256': 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=',
        'x-amz-meta-artifact-id': ARTIFACT_ID,
        'x-amz-meta-byte-length': '5',
        'x-amz-meta-media-type': 'text/plain',
        'x-amz-meta-sha256': HELLO_SHA256,
        'x-amz-meta-workspace-id': WORKSPACE_ID,
      },
      method: 'PUT',
      url: 'https://uploads.example.test/signed',
    });
    expect(new Date(upload.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(fixture.presignRequest?.command.input).toMatchObject({
      Bucket: 'pertexo-artifacts',
      ChecksumSHA256: 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=',
      ContentLength: 5,
      ContentType: 'text/plain',
      IfNoneMatch: '*',
      Key: `workspaces/${WORKSPACE_ID}/artifacts/${ARTIFACT_ID}`,
    });
    expect(fixture.presignRequest?.signableHeaders).toEqual(
      new Set(['content-length', 'content-type', 'if-none-match']),
    );
    expect(fixture.presignRequest?.unhoistableHeaders).toContain(
      'x-amz-checksum-sha256',
    );
  });

  it('bounds a hung presigner and remains usable after cancellation', async () => {
    const client = new MemoryS3Client();
    const controller = new AbortController();
    const cancellation = new Error('request cancelled');
    let calls = 0;
    const store = createArtifactStore(
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
        presignPutObject: () => {
          calls += 1;
          return calls === 1
            ? new Promise<string>(() => undefined)
            : Promise.resolve('https://uploads.example.test/signed');
        },
      },
    );
    const pending = store.beginDirectUpload({
      artifactId: ARTIFACT_ID,
      byteLength: 5,
      expiresInSeconds: 300,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      signal: controller.signal,
      workspaceId: WORKSPACE_ID,
    });
    controller.abort(cancellation);
    await expect(pending).rejects.toBe(cancellation);
    await expect(
      store.beginDirectUpload({
        artifactId: ARTIFACT_ID,
        byteLength: 5,
        expiresInSeconds: 300,
        mediaType: 'text/plain',
        sha256: HELLO_SHA256,
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toMatchObject({ method: 'PUT' });
  });

  it('preserves caller cancellation through post-upload verification', async () => {
    const client = new MemoryS3Client();
    client.hangHead = true;
    const { store } = createStore(client);
    const controller = new AbortController();
    const cancellation = new Error('caller stopped waiting');
    const pending = store.put({
      artifactId: ARTIFACT_ID,
      body: Readable.from(['hello']),
      byteLength: 5,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      signal: controller.signal,
      workspaceId: WORKSPACE_ID,
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(cancellation);
    await expect(pending).rejects.toBe(cancellation);
  });

  it('validates direct upload bytes using the provider full-object checksum', async () => {
    const { client, store } = createStore();
    const metadata = {
      artifactId: ARTIFACT_ID,
      byteLength: 5,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      workspaceId: WORKSPACE_ID,
    };
    await store.put({ ...metadata, body: Readable.from(['hello']) });

    await expect(store.validateDirectUpload(metadata)).resolves.toEqual(
      metadata,
    );
    expect(client.getCalls).toBe(0);
  });

  it('falls back to bounded body verification when provider checksum is absent', async () => {
    const { client, store } = createStore();
    const metadata = {
      artifactId: ARTIFACT_ID,
      byteLength: 5,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      workspaceId: WORKSPACE_ID,
    };
    await store.put({ ...metadata, body: Readable.from(['hello']) });
    client.provideProviderChecksum = false;

    await expect(store.validateDirectUpload(metadata)).resolves.toEqual(
      metadata,
    );
    expect(client.getCalls).toBe(1);

    client.corrupt(metadata);
    await expect(store.validateDirectUpload(metadata)).rejects.toBeInstanceOf(
      ArtifactIntegrityError,
    );
  });

  it('destroys the S3 response body when get metadata is invalid', async () => {
    const { client, store } = createStore();
    await store.put({
      artifactId: ARTIFACT_ID,
      body: Readable.from(['hello']),
      byteLength: 5,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      workspaceId: WORKSPACE_ID,
    });
    client.useInvalidGetMetadata = true;

    await expect(
      store.getStream({
        artifactId: ARTIFACT_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
    expect(client.lastGetBody?.destroyed).toBe(true);
  });

  it('destroys the upstream S3 body when the returned verifier is abandoned', async () => {
    const { client, store } = createStore();
    await store.put({
      artifactId: ARTIFACT_ID,
      body: Readable.from(['hello']),
      byteLength: 5,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      workspaceId: WORKSPACE_ID,
    });
    const upstream = new Readable({
      read() {
        return undefined;
      },
    });
    client.getBodyFactory = () => upstream;

    const download = await store.getStream({
      artifactId: ARTIFACT_ID,
      workspaceId: WORKSPACE_ID,
    });
    download.body.destroy();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(upstream.destroyed).toBe(true);
  });

  it('enforces the request timeout while consuming a post-header body', async () => {
    const { client, store } = createStore();
    await store.put({
      artifactId: ARTIFACT_ID,
      body: Readable.from(['hello']),
      byteLength: 5,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      workspaceId: WORKSPACE_ID,
    });
    const upstream = new Readable({
      read() {
        return undefined;
      },
    });
    client.getBodyFactory = () => upstream;

    const download = await store.getStream({
      artifactId: ARTIFACT_ID,
      workspaceId: WORKSPACE_ID,
    });
    await expect(readAll(download.body)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(upstream.destroyed).toBe(true);
  });

  it('propagates caller abort after GET headers to the returned body', async () => {
    const { client, store } = createStore();
    await store.put({
      artifactId: ARTIFACT_ID,
      body: Readable.from(['hello']),
      byteLength: 5,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      workspaceId: WORKSPACE_ID,
    });
    const upstream = new Readable({
      read() {
        return undefined;
      },
    });
    client.getBodyFactory = () => upstream;
    const controller = new AbortController();

    const download = await store.getStream({
      artifactId: ARTIFACT_ID,
      signal: controller.signal,
      workspaceId: WORKSPACE_ID,
    });
    const aborted = new Error('caller stopped download');
    controller.abort(aborted);

    await expect(readAll(download.body)).rejects.toBe(aborted);
    expect(upstream.destroyed).toBe(true);
  });

  it('destroys the upstream S3 body when stream verification fails', async () => {
    const { client, store } = createStore();
    await store.put({
      artifactId: ARTIFACT_ID,
      body: Readable.from(['hello']),
      byteLength: 5,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      workspaceId: WORKSPACE_ID,
    });
    const upstream = new Readable({
      read() {
        this.push('hello!');
      },
    });
    client.getBodyFactory = () => upstream;

    const download = await store.getStream({
      artifactId: ARTIFACT_ID,
      workspaceId: WORKSPACE_ID,
    });
    await expect(readAll(download.body)).rejects.toBeInstanceOf(
      ArtifactIntegrityError,
    );
    expect(upstream.destroyed).toBe(true);
  });

  it('detects corruption while the downloaded stream is consumed', async () => {
    const { client, store } = createStore();
    await store.put({
      artifactId: ARTIFACT_ID,
      body: Readable.from(['hello']),
      byteLength: 5,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      workspaceId: WORKSPACE_ID,
    });
    client.corrupt({ artifactId: ARTIFACT_ID, workspaceId: WORKSPACE_ID });

    const download = await store.getStream({
      artifactId: ARTIFACT_ID,
      workspaceId: WORKSPACE_ID,
    });
    await expect(readAll(download.body)).rejects.toBeInstanceOf(
      ArtifactIntegrityError,
    );
  });

  it('deletes idempotently and reports a missing download', async () => {
    const { store } = createStore();
    const identity = { artifactId: ARTIFACT_ID, workspaceId: WORKSPACE_ID };

    await store.delete(identity);
    await store.delete(identity);
    await expect(store.head(identity)).resolves.toBeNull();
    await expect(store.getStream(identity)).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    );
  });

  it('deletes one bounded workspace page of versions and delete markers', async () => {
    const { client, store } = createStore();
    const prefix = `workspaces/${WORKSPACE_ID}/`;
    client.versionListOutput = {
      DeleteMarkers: [{ Key: `${prefix}markers/one`, VersionId: 'marker-1' }],
      IsTruncated: true,
      Versions: [
        { Key: `${prefix}artifacts/${ARTIFACT_ID}`, VersionId: 'version-1' },
      ],
    };

    await expect(
      store.purgeWorkspacePage({ maxObjects: 2, workspaceId: WORKSPACE_ID }),
    ).resolves.toEqual({ completed: false, deletedCount: 2 });
    expect(client.versionListInput).toMatchObject({
      MaxKeys: 2,
      Prefix: prefix,
    });
    expect(client.deletedVersions).toEqual([
      { Key: `${prefix}artifacts/${ARTIFACT_ID}`, VersionId: 'version-1' },
      { Key: `${prefix}markers/one`, VersionId: 'marker-1' },
    ]);
  });

  it('completes only on a fresh empty version listing', async () => {
    const { client, store } = createStore();

    await expect(
      store.purgeWorkspacePage({ maxObjects: 500, workspaceId: WORKSPACE_ID }),
    ).resolves.toEqual({ completed: true, deletedCount: 0 });
    expect(client.deletedVersions).toBeUndefined();

    client.versionListOutput = { IsTruncated: true };
    await expect(
      store.purgeWorkspacePage({ maxObjects: 500, workspaceId: WORKSPACE_ID }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it('rejects malformed, foreign, duplicate, and over-bound listings', async () => {
    const { client, store } = createStore();
    const purge = () =>
      store.purgeWorkspacePage({ maxObjects: 1, workspaceId: WORKSPACE_ID });

    client.versionListOutput = {
      Versions: [{ Key: 'workspaces/foreign/artifacts/one', VersionId: 'v1' }],
    };
    await expect(purge()).rejects.toBeInstanceOf(ArtifactIntegrityError);
    client.versionListOutput = {
      Versions: [
        {
          Key: `workspaces/${WORKSPACE_ID}/artifacts/one`,
          VersionId: '',
        },
      ],
    };
    await expect(purge()).rejects.toBeInstanceOf(ArtifactIntegrityError);
    const duplicate = {
      Key: `workspaces/${WORKSPACE_ID}/artifacts/one`,
      VersionId: 'v1',
    };
    client.versionListOutput = {
      DeleteMarkers: [duplicate],
      Versions: [duplicate],
    };
    await expect(
      store.purgeWorkspacePage({ maxObjects: 2, workspaceId: WORKSPACE_ID }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
    client.versionListOutput = {
      Versions: [duplicate, { ...duplicate, VersionId: 'v2' }],
    };
    await expect(purge()).rejects.toBeInstanceOf(ArtifactIntegrityError);
    expect(client.deletedVersions).toBeUndefined();
  });

  it('fails a page when S3 reports a partial version deletion error', async () => {
    const { client, store } = createStore();
    const key = `workspaces/${WORKSPACE_ID}/artifacts/${ARTIFACT_ID}`;
    client.versionListOutput = {
      Versions: [{ Key: key, VersionId: 'version-1' }],
    };
    client.deleteVersionsErrors = [
      { Code: 'AccessDenied', Key: key, VersionId: 'version-1' },
    ];

    await expect(
      store.purgeWorkspacePage({ maxObjects: 1, workspaceId: WORKSPACE_ID }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it.each([
    { acknowledgements: [] },
    { acknowledgements: [{ Key: 'foreign', VersionId: 'version-1' }] },
    {
      acknowledgements: [
        {
          Key: `workspaces/${WORKSPACE_ID}/artifacts/${ARTIFACT_ID}`,
          VersionId: 'version-1',
        },
        {
          Key: `workspaces/${WORKSPACE_ID}/artifacts/${ARTIFACT_ID}`,
          VersionId: 'version-1',
        },
      ],
    },
    { acknowledgements: [{ VersionId: 'version-1' }] },
  ])(
    'rejects an invalid delete acknowledgement set: %#',
    async ({ acknowledgements }) => {
      const { client, store } = createStore();
      const key = `workspaces/${WORKSPACE_ID}/artifacts/${ARTIFACT_ID}`;
      client.versionListOutput = {
        Versions: [{ Key: key, VersionId: 'version-1' }],
      };
      client.deleteVersionsAcknowledgements = acknowledgements;
      await expect(
        store.purgeWorkspacePage({ maxObjects: 1, workspaceId: WORKSPACE_ID }),
      ).rejects.toBeInstanceOf(ArtifactIntegrityError);
    },
  );

  it('bounds readiness and closes the client exactly once', async () => {
    const client = new MemoryS3Client();
    client.hangReadiness = true;
    const { store } = createStore(client);

    await expect(store.checkReadiness()).rejects.toBeDefined();
    store.close();
    store.close();
    expect(client.destroyCalls).toBe(1);
    await expect(
      store.head({ artifactId: ARTIFACT_ID, workspaceId: WORKSPACE_ID }),
    ).rejects.toBeInstanceOf(ArtifactStoreClosedError);
  });

  it('borrows injected clients by default and can explicitly own them', () => {
    const borrowed = new MemoryS3Client();
    const borrowedStore = createArtifactStore(
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
      { client: borrowed, presignPutObject: () => Promise.resolve('signed') },
    );
    borrowedStore.close();
    borrowedStore.close();
    expect(borrowed.destroyCalls).toBe(0);

    const owned = new MemoryS3Client();
    const ownedStore = createArtifactStore(
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
        client: owned,
        clientOwnership: 'owned',
        presignPutObject: () => Promise.resolve('signed'),
      },
    );
    ownedStore.close();
    ownedStore.close();
    expect(owned.destroyCalls).toBe(1);
  });

  it('reports readiness without exposing credentials', async () => {
    const { store } = createStore();
    await expect(store.checkReadiness()).resolves.toEqual({
      bucket: 'pertexo-artifacts',
      region: 'us-east-1',
    });
  });
});
