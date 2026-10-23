import { Readable } from 'node:stream';
import { expect, it } from 'vitest';

import {
  ArtifactIntegrityError,
  ArtifactStoreClosedError,
} from '../../src/store.js';

import {
  WORKSPACE_ID,
  ARTIFACT_ID,
  HELLO_SHA256,
  createStore,
  readAll,
} from './fixture.js';

export function registerRejectsHTTPUnsafeArtifactMediaType(): void {
  it.each([
    'application/js\u000bon',
    'application/js\u001fon',
    'application/js\u007fon',
    'application/js\u0100on',
  ])(
    'rejects an HTTP-unsafe artifact media type before signing %#',
    async (mediaType) => {
      const fixture = createStore();

      await expect(
        fixture.store.beginDirectUpload({
          artifactId: ARTIFACT_ID,
          byteLength: 5,
          expiresInSeconds: 300,
          mediaType,
          sha256: HELLO_SHA256,
          workspaceId: WORKSPACE_ID,
        }),
      ).rejects.toThrow();
      expect(fixture.presignRequest).toBeUndefined();
    },
  );

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

  it('leaves the caller stream owned by the caller when PUT preflight rejects', async () => {
    const { store } = createStore();
    store.close();
    const body = new Readable({
      read() {
        // Preflight must reject before requesting or owning bytes.
      },
    });

    await expect(
      store.put({
        artifactId: ARTIFACT_ID,
        body,
        byteLength: 5,
        mediaType: 'text/plain',
        sha256: HELLO_SHA256,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toBeInstanceOf(ArtifactStoreClosedError);

    expect(body.destroyed).toBe(false);
    body.destroy();
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
}
