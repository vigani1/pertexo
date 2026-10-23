import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';

import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
} from '../../src/store.js';

import {
  WORKSPACE_ID,
  ARTIFACT_ID,
  HELLO_SHA256,
  MemoryS3Client,
  createStore,
} from './fixture.js';

export function registerDeletesIdempotentlyReportsMissingDownload(): void {
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

  it('preserves non-not-found GET and direct-upload HEAD failures', async () => {
    const client = new MemoryS3Client();
    const { store } = createStore(client);
    const metadata = {
      artifactId: ARTIFACT_ID,
      byteLength: 5,
      mediaType: 'text/plain',
      sha256: HELLO_SHA256,
      workspaceId: WORKSPACE_ID,
    };
    await store.put({ ...metadata, body: Readable.from(['hello']) });

    const getFailure = new Error('provider GET failed');
    client.getError = getFailure;
    await expect(store.getStream(metadata)).rejects.toBe(getFailure);
    client.getError = undefined;

    const headFailure = new Error('provider HEAD failed');
    client.headError = headFailure;
    await expect(store.validateDirectUpload(metadata)).rejects.toBe(
      headFailure,
    );
  });

  it('maps a missing direct-upload HEAD to ArtifactNotFoundError', async () => {
    const client = new MemoryS3Client();
    const { store } = createStore(client);
    client.headError = Object.assign(new Error('missing'), {
      $metadata: { httpStatusCode: 404 },
      name: 'NotFound',
    });

    await expect(
      store.validateDirectUpload({
        artifactId: ARTIFACT_ID,
        byteLength: 5,
        mediaType: 'text/plain',
        sha256: HELLO_SHA256,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
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
    expect(client.commands).toHaveLength(2);
    expect(client.commands[0]).toBeInstanceOf(ListObjectVersionsCommand);
    expect(client.commands[1]).toBeInstanceOf(DeleteObjectsCommand);
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

  it.each([
    [
      'foreign workspace key',
      {
        Versions: [
          { Key: 'workspaces/foreign/artifacts/one', VersionId: 'v1' },
        ],
      },
      1,
    ],
    [
      'empty version identity',
      {
        Versions: [
          {
            Key: `workspaces/${WORKSPACE_ID}/artifacts/one`,
            VersionId: '',
          },
        ],
      },
      1,
    ],
    [
      'duplicate version identity',
      {
        DeleteMarkers: [
          {
            Key: `workspaces/${WORKSPACE_ID}/artifacts/one`,
            VersionId: 'v1',
          },
        ],
        Versions: [
          {
            Key: `workspaces/${WORKSPACE_ID}/artifacts/one`,
            VersionId: 'v1',
          },
        ],
      },
      2,
    ],
    [
      'listing beyond caller bound',
      {
        Versions: [
          {
            Key: `workspaces/${WORKSPACE_ID}/artifacts/one`,
            VersionId: 'v1',
          },
          {
            Key: `workspaces/${WORKSPACE_ID}/artifacts/one`,
            VersionId: 'v2',
          },
        ],
      },
      1,
    ],
  ] as const)(
    'rejects a workspace object listing with %s',
    async (_case, listing, maxObjects) => {
      const { client, store } = createStore();
      client.versionListOutput = listing;

      await expect(
        store.purgeWorkspacePage({ maxObjects, workspaceId: WORKSPACE_ID }),
      ).rejects.toBeInstanceOf(ArtifactIntegrityError);
      expect(client.deletedVersions).toBeUndefined();
    },
  );

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
    ).rejects.toThrow('Object version deletion reported one or more failures');
  });
}
