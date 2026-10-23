import { Readable } from 'node:stream';
import { expect, it } from 'vitest';

import { ArtifactIntegrityError } from '../../src/store.js';

import {
  WORKSPACE_ID,
  ARTIFACT_ID,
  HELLO_SHA256,
  createStore,
  readAll,
} from './fixture.js';

export function registerDestroysS3ResponseBodyGetMetadata(): void {
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

  it('normalizes a primitive caller abort after GET headers', async () => {
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
    controller.abort('caller stopped download');

    await expect(readAll(download.body)).rejects.toThrow(
      'Artifact transfer aborted',
    );
    expect(upstream.destroyed).toBe(true);
  });

  it('closes the race when cancellation occurs before body verification is wired', async () => {
    const { client, store } = createStore();
    await store.put({
      artifactId: ARTIFACT_ID,
      body: Readable.from(['hello']),
      byteLength: 5,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      workspaceId: WORKSPACE_ID,
    });
    const controller = new AbortController();
    const reason = new Error('cancelled before verifier wiring');

    const pending = store.getStream({
      artifactId: ARTIFACT_ID,
      signal: controller.signal,
      workspaceId: WORKSPACE_ID,
    });
    controller.abort(reason);
    const download = await pending;

    await expect(readAll(download.body)).rejects.toBe(reason);
    expect(client.lastGetBody?.destroyed).toBe(true);
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
}
