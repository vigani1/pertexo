import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { createArtifactStore } from '../../src/store.js';
import { ArtifactIntegrityError } from '../../src/store.js';

import {
  WORKSPACE_ID,
  ARTIFACT_ID,
  HELLO_SHA256,
  MemoryS3Client,
  createStore,
} from './fixture.js';

export function registerPreservesCallerCancellationThroughPostUpload(): void {
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

  it.each([
    ['primitive', 'not-a-stream', false],
    ['destroyable', { destroy: () => undefined }, true],
  ] as const)(
    'rejects a %s provider body and destroys it when supported',
    async (_name, body, destroyable) => {
      const { client, store } = createStore();
      await store.put({
        artifactId: ARTIFACT_ID,
        body: Readable.from(['hello']),
        byteLength: 5,
        mediaType: 'text/plain',
        sha256: HELLO_SHA256,
        workspaceId: WORKSPACE_ID,
      });
      let destroyed = false;
      client.getBodyOverride = destroyable
        ? { destroy: () => (destroyed = true) }
        : body;

      await expect(
        store.getStream({
          artifactId: ARTIFACT_ID,
          workspaceId: WORKSPACE_ID,
        }),
      ).rejects.toThrow('not streamable');
      expect(destroyed).toBe(destroyable);
    },
  );

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

  it.each([
    ['mismatched metadata', () => ({ useInvalidHeadMetadata: true })],
    ['mismatched length', () => ({ contentLengthOverride: 4 })],
    ['non-full checksum', () => ({ checksumTypeOverride: 'COMPOSITE' })],
    ['wrong checksum', () => ({ checksumSha256Override: 'not-the-checksum' })],
  ] as const)('rejects a direct upload with %s', async (_label, configure) => {
    const { client, store } = createStore();
    const upload = {
      artifactId: ARTIFACT_ID,
      byteLength: 5,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      workspaceId: WORKSPACE_ID,
    } as const;
    await store.put({ ...upload, body: Readable.from(['hello']) });
    Object.assign(client, configure());

    await expect(store.validateDirectUpload(upload)).rejects.toBeInstanceOf(
      ArtifactIntegrityError,
    );
  });

  it('rejects individually valid direct-upload metadata that differs from the request', async () => {
    const { client, store } = createStore();
    const upload = {
      artifactId: ARTIFACT_ID,
      byteLength: 5,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      workspaceId: WORKSPACE_ID,
    } as const;
    await store.put({ ...upload, body: Readable.from(['hello']) });
    client.headMetadataOverride = {
      'artifact-id': ARTIFACT_ID,
      'byte-length': '5',
      'media-type': 'text/plain',
      sha256: 'a'.repeat(64),
      'workspace-id': WORKSPACE_ID,
    };

    await expect(store.validateDirectUpload(upload)).rejects.toThrow(
      'Stored artifact metadata does not match the expected upload',
    );
    expect(client.getCalls).toBe(0);
  });

  it('maps only recognized missing-provider shapes to not found', async () => {
    const { client, store } = createStore();
    client.getError = Object.assign(new Error('provider failure'), {
      name: 'SomethingElse',
    });

    await expect(
      store.getStream({ artifactId: ARTIFACT_ID, workspaceId: WORKSPACE_ID }),
    ).rejects.toBe(client.getError);

    // Deliberately model an untrusted provider rejecting a primitive.
    client.getError = 'provider-failed' as never;
    await expect(
      store.getStream({ artifactId: ARTIFACT_ID, workspaceId: WORKSPACE_ID }),
    ).rejects.toBe('provider-failed');
  });

  it('normalizes EU bucket location to eu-west-1', async () => {
    const client = new MemoryS3Client();
    client.locationConstraint = 'EU';
    const store = createArtifactStore(
      {
        accessKeyId: 'access',
        bucket: 'pertexo-artifacts',
        endpoint: 'http://localhost:9090',
        forcePathStyle: true,
        maxObjectBytes: 10 * 1024 * 1024,
        region: 'eu-west-1',
        requestTimeoutMs: 100,
        secretAccessKey: 'secret',
      },
      { client },
    );

    await expect(store.checkReadiness()).resolves.toEqual({
      bucket: 'pertexo-artifacts',
      region: 'eu-west-1',
    });
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

  it('rejects valid fallback-download metadata that differs from the expected upload', async () => {
    const { client, store } = createStore();
    const upload = {
      artifactId: ARTIFACT_ID,
      byteLength: 5,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      workspaceId: WORKSPACE_ID,
    } as const;
    await store.put({ ...upload, body: Readable.from(['hello']) });
    client.provideProviderChecksum = false;
    client.getMetadataOverride = {
      'artifact-id': ARTIFACT_ID,
      'byte-length': '5',
      'media-type': 'text/plain',
      sha256: 'a'.repeat(64),
      'workspace-id': WORKSPACE_ID,
    };

    await expect(store.validateDirectUpload(upload)).rejects.toThrow(
      'Stored artifact metadata does not match the expected upload',
    );
    expect(client.lastGetBody?.destroyed).toBe(true);
  });
}
