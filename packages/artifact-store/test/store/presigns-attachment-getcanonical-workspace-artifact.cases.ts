import { expect, it } from 'vitest';
import { createArtifactStore } from '../../src/store.js';
import { ArtifactStoreClosedError } from '../../src/store.js';

import {
  WORKSPACE_ID,
  ARTIFACT_ID,
  HELLO_SHA256,
  MemoryS3Client,
  createStore,
} from './fixture.js';

export function registerPresignsAttachmentGETCanonicalWorkspaceArtifact(): void {
  it('presigns an attachment GET for the canonical workspace artifact key', async () => {
    const fixture = createStore();
    const hostileRequest = {
      artifactId: ARTIFACT_ID,
      expiresInSeconds: 300,
      filename: '../../credentials.txt',
      key: 'workspaces/foreign/artifacts/foreign',
      workspaceId: WORKSPACE_ID,
    };
    const download = await fixture.store.beginDirectDownload(hostileRequest);

    expect(download).toMatchObject({
      expiresInSeconds: 300,
      method: 'GET',
      url: 'https://downloads.example.test/signed',
    });
    expect(new Date(download.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(fixture.presignGetRequest?.command.input).toMatchObject({
      Bucket: 'pertexo-artifacts',
      Key: `workspaces/${WORKSPACE_ID}/artifacts/${ARTIFACT_ID}`,
      ResponseContentDisposition: 'attachment',
    });
    expect(
      JSON.stringify(fixture.presignGetRequest?.command.input),
    ).not.toContain('credentials.txt');
    expect(
      JSON.stringify(fixture.presignGetRequest?.command.input),
    ).not.toContain('foreign');
  });

  it.each([59, 901, 60.5, 900.5])(
    'rejects a direct download TTL outside the bounded integer range (%s)',
    async (expiresInSeconds) => {
      const fixture = createStore();

      await expect(
        fixture.store.beginDirectDownload({
          artifactId: ARTIFACT_ID,
          expiresInSeconds,
          workspaceId: WORKSPACE_ID,
        }),
      ).rejects.toThrow();
      expect(fixture.presignGetRequest).toBeUndefined();
    },
  );

  it('bounds a hung download presigner and remains usable after cancellation', async () => {
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
        presignGetObject: () => {
          calls += 1;
          return calls === 1
            ? new Promise<string>(() => undefined)
            : Promise.resolve('https://downloads.example.test/signed');
        },
      },
    );
    const pending = store.beginDirectDownload({
      artifactId: ARTIFACT_ID,
      expiresInSeconds: 300,
      signal: controller.signal,
      workspaceId: WORKSPACE_ID,
    });
    controller.abort(cancellation);

    await expect(pending).rejects.toBe(cancellation);
    await expect(
      store.beginDirectDownload({
        artifactId: ARTIFACT_ID,
        expiresInSeconds: 300,
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toMatchObject({ method: 'GET' });
  });

  it('rejects direct download signing after the store is closed', async () => {
    const fixture = createStore();
    fixture.store.close();

    await expect(
      fixture.store.beginDirectDownload({
        artifactId: ARTIFACT_ID,
        expiresInSeconds: 300,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toBeInstanceOf(ArtifactStoreClosedError);
    expect(fixture.presignGetRequest).toBeUndefined();
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

  it('normalizes non-Error presign failures and abort reasons', async () => {
    const client = new MemoryS3Client();
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
            ? // Deliberately model an untrusted provider rejecting a primitive.
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
              Promise.reject('provider-failed')
            : new Promise<string>(() => undefined);
        },
      },
    );
    const request = {
      artifactId: ARTIFACT_ID,
      byteLength: 5,
      expiresInSeconds: 300,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      workspaceId: WORKSPACE_ID,
    } as const;

    await expect(store.beginDirectUpload(request)).rejects.toMatchObject({
      message: 'Artifact operation failed',
      cause: 'provider-failed',
    });

    const controller = new AbortController();
    const pending = store.beginDirectUpload({
      ...request,
      signal: controller.signal,
    });
    controller.abort('caller-stopped');
    await expect(pending).rejects.toMatchObject({
      message: 'Artifact operation aborted',
      cause: 'caller-stopped',
    });
  });
}
