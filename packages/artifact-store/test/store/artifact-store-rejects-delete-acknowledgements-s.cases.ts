import { expect, it } from 'vitest';
import { createArtifactStore } from '../../src/store.js';
import {
  ArtifactIntegrityError,
  ArtifactStoreClosedError,
} from '../../src/store.js';

import {
  WORKSPACE_ID,
  ARTIFACT_ID,
  MemoryS3Client,
  createStore,
} from './fixture.js';

export function registerArtifactStoreRejectsDeleteAcknowledgementsS(): void {
  it.each([
    ['missing acknowledgement', [], ['version-1']],
    [
      'foreign identity',
      [{ Key: 'foreign', VersionId: 'version-1' }],
      ['version-1'],
    ],
    [
      'duplicate identity',
      [
        {
          Key: `workspaces/${WORKSPACE_ID}/artifacts/${ARTIFACT_ID}`,
          VersionId: 'version-1',
        },
        {
          Key: `workspaces/${WORKSPACE_ID}/artifacts/${ARTIFACT_ID}`,
          VersionId: 'version-1',
        },
      ],
      ['version-1', 'version-2'],
    ],
    ['missing key', [{ VersionId: 'version-1' }], ['version-1']],
  ] as const)(
    'rejects delete acknowledgements with %s',
    async (_case, acknowledgements, requestedVersions) => {
      const { client, store } = createStore();
      const key = `workspaces/${WORKSPACE_ID}/artifacts/${ARTIFACT_ID}`;
      client.versionListOutput = {
        Versions: requestedVersions.map((VersionId) => ({
          Key: key,
          VersionId,
        })),
      };
      client.deleteVersionsAcknowledgements = acknowledgements;
      await expect(
        store.purgeWorkspacePage({
          maxObjects: requestedVersions.length,
          workspaceId: WORKSPACE_ID,
        }),
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

  it('normalizes the S3-compatible root-region location response', async () => {
    const { client, store } = createStore();
    client.locationConstraint = 'null';
    await expect(store.checkReadiness()).resolves.toEqual({
      bucket: 'pertexo-artifacts',
      region: 'us-east-1',
    });
  });

  it('rejects a configured region that disagrees with provider location', async () => {
    const { client, store } = createStore();
    client.locationConstraint = 'eu-west-1';
    await expect(store.checkReadiness()).rejects.toThrow(/region/u);
  });
}
