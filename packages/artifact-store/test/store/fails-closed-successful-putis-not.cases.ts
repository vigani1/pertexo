import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { createArtifactStore } from '../../src/store.js';

import {
  WORKSPACE_ID,
  ARTIFACT_ID,
  HELLO_SHA256,
  MemoryS3Client,
  createStore,
} from './fixture.js';

export function registerFailsClosedSuccessfulPUTIsNot(): void {
  it('fails closed when a successful PUT is not visible to its verification HEAD', async () => {
    const { client, store } = createStore();
    client.nextHeadNotFound = true;

    await expect(
      store.put({
        artifactId: ARTIFACT_ID,
        body: Readable.from(['hello']),
        byteLength: 5,
        mediaType: 'text/plain',
        sha256: HELLO_SHA256,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toMatchObject({
      name: 'ArtifactIntegrityError',
      message: 'Uploaded artifact is unavailable',
    });

    await expect(
      store.head({ artifactId: ARTIFACT_ID, workspaceId: WORKSPACE_ID }),
    ).resolves.toMatchObject({
      sha256: HELLO_SHA256,
    });
  });

  it.each([
    [
      'checksum',
      {
        metadata: {
          'artifact-id': ARTIFACT_ID,
          'byte-length': '5',
          'media-type': 'text/plain',
          sha256: 'a'.repeat(64),
          'workspace-id': WORKSPACE_ID,
        },
      },
    ],
    [
      'media type',
      {
        contentType: 'application/json',
        metadata: {
          'artifact-id': ARTIFACT_ID,
          'byte-length': '5',
          'media-type': 'application/json',
          sha256: HELLO_SHA256,
          'workspace-id': WORKSPACE_ID,
        },
      },
    ],
    [
      'byte length',
      {
        contentLength: 6,
        metadata: {
          'artifact-id': ARTIFACT_ID,
          'byte-length': '6',
          'media-type': 'text/plain',
          sha256: HELLO_SHA256,
          'workspace-id': WORKSPACE_ID,
        },
      },
    ],
  ] as const)(
    'retains the object but rejects changed verification %s after PUT',
    async (_field, override) => {
      const { client, store } = createStore();
      client.headMetadataOverride = override.metadata;
      client.contentLengthOverride =
        'contentLength' in override ? override.contentLength : undefined;
      client.contentTypeOverride =
        'contentType' in override ? override.contentType : undefined;

      await expect(
        store.put({
          artifactId: ARTIFACT_ID,
          body: Readable.from(['hello']),
          byteLength: 5,
          mediaType: 'text/plain',
          sha256: HELLO_SHA256,
          workspaceId: WORKSPACE_ID,
        }),
      ).rejects.toMatchObject({
        name: 'ArtifactIntegrityError',
        message:
          'Uploaded artifact metadata does not match the requested artifact',
      });
      expect(
        client.commands.some(
          (command) => command instanceof DeleteObjectCommand,
        ),
      ).toBe(false);

      client.headMetadataOverride = undefined;
      client.contentLengthOverride = undefined;
      client.contentTypeOverride = undefined;
      await expect(
        store.head({ artifactId: ARTIFACT_ID, workspaceId: WORKSPACE_ID }),
      ).resolves.toMatchObject({ sha256: HELLO_SHA256 });
    },
  );

  it.each(['upload', 'download'] as const)(
    'owns a presigner rejection when cancellation occurs during %s invocation',
    async (operation) => {
      const controller = new AbortController();
      const cancellation = new Error('caller cancelled during presign');
      const lateFailure = new Error('presigner rejected');
      const rejectAfterAbort = () => {
        controller.abort(cancellation);
        return Promise.reject(lateFailure);
      };
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
          client: new MemoryS3Client(),
          presignGetObject: rejectAfterAbort,
          presignPutObject: rejectAfterAbort,
        },
      );

      const signing =
        operation === 'upload'
          ? store.beginDirectUpload({
              artifactId: ARTIFACT_ID,
              byteLength: 5,
              expiresInSeconds: 300,
              mediaType: 'text/plain',
              sha256: HELLO_SHA256,
              signal: controller.signal,
              workspaceId: WORKSPACE_ID,
            })
          : store.beginDirectDownload({
              artifactId: ARTIFACT_ID,
              expiresInSeconds: 300,
              signal: controller.signal,
              workspaceId: WORKSPACE_ID,
            });

      await expect(signing).rejects.toBe(cancellation);
      await Promise.resolve();
    },
  );

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
}
