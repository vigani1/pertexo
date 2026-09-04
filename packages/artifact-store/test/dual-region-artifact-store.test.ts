import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  ArtifactPartialReplicationError,
  createDualRegionArtifactStore,
} from '../src/dual-region-artifact-store.js';
import { ArtifactIntegrityError } from '../src/store.js';
import type {
  ArtifactDownload,
  ArtifactMetadata,
  ArtifactRequest,
  ArtifactStore,
  ArtifactStoreReadiness,
  BeginDirectUploadRequest,
  DirectUpload,
  PurgeWorkspaceObjectsRequest,
  PutArtifactRequest,
  ValidateDirectUploadRequest,
  WorkspaceObjectPurgePage,
  WorkspaceObjectPurgeStore,
} from '../src/store.js';

const metadata = Object.freeze({
  artifactId: '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c02',
  byteLength: 5,
  mediaType: 'text/plain',
  sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  workspaceId: '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c01',
});

class FakeArtifactStore implements ArtifactStore, WorkspaceObjectPurgeStore {
  public closeCalls = 0;
  public closeError: Error | undefined;
  public deleteCalls = 0;
  public failNextPut = false;
  public purgeResult: WorkspaceObjectPurgePage = {
    completed: true,
    deletedCount: 0,
  };
  public stored: { body: Buffer; metadata: ArtifactMetadata } | undefined;

  public constructor(
    private readonly bucket: string,
    private readonly region: string,
  ) {}

  public beginDirectUpload(
    request: BeginDirectUploadRequest,
  ): Promise<DirectUpload> {
    void request;
    return Promise.resolve({
      expiresAt: '2026-08-28T12:00:00.000Z',
      expiresInSeconds: 300,
      headers: {},
      method: 'PUT',
      url: 'https://uploads.example.test/signed',
    });
  }

  public checkReadiness(): Promise<ArtifactStoreReadiness> {
    return Promise.resolve({ bucket: this.bucket, region: this.region });
  }

  public close(): void {
    this.closeCalls += 1;
    if (this.closeError !== undefined) throw this.closeError;
  }

  public delete(request: ArtifactRequest): Promise<void> {
    void request;
    this.deleteCalls += 1;
    this.stored = undefined;
    return Promise.resolve();
  }

  public getStream(request: ArtifactRequest): Promise<ArtifactDownload> {
    void request;
    if (this.stored === undefined) throw new Error('not found');
    return Promise.resolve({
      body: Readable.from([this.stored.body]),
      metadata: this.stored.metadata,
    });
  }

  public head(request: ArtifactRequest): Promise<ArtifactMetadata | null> {
    void request;
    return Promise.resolve(this.stored?.metadata ?? null);
  }

  public purgeWorkspacePage(
    request: PurgeWorkspaceObjectsRequest,
  ): Promise<WorkspaceObjectPurgePage> {
    void request;
    return Promise.resolve(this.purgeResult);
  }

  public async put(request: PutArtifactRequest): Promise<ArtifactMetadata> {
    const chunks: Buffer[] = [];
    for await (const chunk of request.body) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    this.stored = { body: Buffer.concat(chunks), metadata: { ...metadata } };
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('response lost');
    }
    return metadata;
  }

  public validateDirectUpload(
    expected: ValidateDirectUploadRequest,
  ): Promise<ArtifactMetadata> {
    if (
      this.stored?.metadata.sha256 !== expected.sha256 ||
      !this.stored.body.equals(Buffer.from('hello'))
    )
      throw new ArtifactIntegrityError('invalid replica');
    return Promise.resolve(this.stored.metadata);
  }
}

function fixture() {
  const primary = new FakeArtifactStore('artifacts-primary', 'eu-central-1');
  const recovery = new FakeArtifactStore('artifacts-recovery', 'eu-west-1');
  return {
    primary,
    recovery,
    store: createDualRegionArtifactStore(primary, recovery, {
      artifactOwnership: 'borrowed',
    }),
  };
}

describe('dual-region artifact store', () => {
  it('writes and checksum-validates both regions before returning', async () => {
    const { primary, recovery, store } = fixture();

    await expect(
      store.put({ ...metadata, body: Readable.from(['hello']) }),
    ).resolves.toEqual(metadata);
    expect(primary.stored?.body).toEqual(Buffer.from('hello'));
    expect(recovery.stored?.body).toEqual(Buffer.from('hello'));
    await expect(store.verifyReplicas(metadata)).resolves.toEqual(metadata);
  });

  it('retains a partial write and heals it on exact retry', async () => {
    const { primary, recovery, store } = fixture();
    recovery.failNextPut = true;

    await expect(
      store.put({ ...metadata, body: Readable.from(['hello']) }),
    ).rejects.toBeInstanceOf(ArtifactPartialReplicationError);
    expect(primary.stored).toBeDefined();
    expect(recovery.stored).toBeDefined();

    await expect(
      store.put({ ...metadata, body: Readable.from(['hello']) }),
    ).resolves.toEqual(metadata);
  });

  it('replicates a primary direct upload before validation succeeds', async () => {
    const { primary, recovery, store } = fixture();
    primary.stored = { body: Buffer.from('hello'), metadata };

    await expect(store.validateDirectUpload(metadata)).resolves.toEqual(
      metadata,
    );
    expect(recovery.stored?.body).toEqual(Buffer.from('hello'));
  });

  it('proves region isolation and coordinated purge outcomes', async () => {
    const { primary, recovery, store } = fixture();
    await expect(store.checkReadiness()).resolves.toMatchObject({
      primary: { bucket: 'artifacts-primary', region: 'eu-central-1' },
      recovery: { bucket: 'artifacts-recovery', region: 'eu-west-1' },
    });

    primary.purgeResult = { completed: false, deletedCount: 2 };
    recovery.purgeResult = { completed: false, deletedCount: 1 };
    await expect(
      store.purgeWorkspacePage({
        maxObjects: 10,
        workspaceId: metadata.workspaceId,
      }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it('requires explicit ownership for injected stores', () => {
    const primary = new FakeArtifactStore('artifacts-primary', 'eu-central-1');
    const recovery = new FakeArtifactStore('artifacts-recovery', 'eu-west-1');
    expect(() => createDualRegionArtifactStore(primary, recovery)).toThrow(
      'explicit ownership',
    );
  });

  it('attempts both owned closes and aggregates their failures once', () => {
    const primary = new FakeArtifactStore('artifacts-primary', 'eu-central-1');
    const recovery = new FakeArtifactStore('artifacts-recovery', 'eu-west-1');
    primary.closeError = new Error('primary close failed');
    recovery.closeError = new Error('recovery close failed');
    const store = createDualRegionArtifactStore(primary, recovery, {
      artifactOwnership: 'owned',
    });

    expect(() => {
      store.close();
    }).toThrow(AggregateError);
    expect(primary.closeCalls).toBe(1);
    expect(recovery.closeCalls).toBe(1);
    expect(() => {
      store.close();
    }).not.toThrow();
    expect(primary.closeCalls).toBe(1);
    expect(recovery.closeCalls).toBe(1);
  });
});
