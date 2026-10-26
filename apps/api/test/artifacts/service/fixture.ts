import { vi } from 'vitest';
import {
  ArtifactService,
  type ArtifactDependencies,
  type ArtifactServiceDependencies,
  type ArtifactRecord,
  type ArtifactStore,
} from '../../../src/artifacts/index.js';
import { createActorContext } from '../../../src/authorization/index.js';

export const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const artifactId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const actor = createActorContext({
  actorId,
  sessionId,
  workspaceId,
  requestId: 'request-artifact-test',
});

export function record(
  overrides: Partial<ArtifactRecord> = {},
): ArtifactRecord {
  const now = new Date('2026-09-06T00:00:00.000Z');
  return {
    id: artifactId,
    workspaceId,
    purpose: 'user-upload',
    storageKey: `workspaces/${workspaceId}/artifacts/${artifactId}`,
    mediaType: 'application/octet-stream',
    byteLength: 4,
    sha256: 'a'.repeat(64),
    status: 'pending',
    expiresAt: new Date(now.getTime() + 15 * 60_000),
    finalizedAt: null,
    deletedAt: null,
    retentionRetryAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function dependencies(
  databaseOverrides: Partial<ArtifactDependencies['database']> = {},
  storeOverrides: Partial<ArtifactStore> = {},
  authorization: ArtifactDependencies['authorization'] = () =>
    Promise.resolve({
      actorId,
      workspaceId,
      role: 'owner' as const,
      membershipStatus: 'active' as const,
      workspaceStatus: 'active' as const,
    }),
): ArtifactServiceDependencies {
  const database = {
    beginUpload: vi
      .fn()
      .mockResolvedValue({ artifact: record(), replayed: false }),
    getForUpload: vi.fn().mockResolvedValue(record()),
    finalizeUpload: vi.fn(
      async (
        input: Parameters<
          ArtifactDependencies['database']['finalizeUpload']
        >[0],
      ) => {
        await input.verifyUpload?.();
        return record({ status: 'available' });
      },
    ),
    getMetadata: vi.fn().mockResolvedValue(record()),
    ...databaseOverrides,
  };
  const store = {
    beginDirectUpload: vi
      .fn<NonNullable<ArtifactStore['beginDirectUpload']>>()
      .mockResolvedValue({
        expiresAt: '2026-09-06T00:15:00.000Z',
        expiresInSeconds: 900,
        headers: {},
        method: 'PUT',
        url: 'https://objects.example.test/upload',
      }),
    validateDirectUpload: vi
      .fn<NonNullable<ArtifactStore['validateDirectUpload']>>()
      .mockResolvedValue({
        artifactId,
        workspaceId,
        byteLength: 4,
        mediaType: 'application/octet-stream',
        sha256: 'a'.repeat(64),
      }),
    beginDirectDownload: vi
      .fn<NonNullable<ArtifactStore['beginDirectDownload']>>()
      .mockResolvedValue({
        expiresAt: '2026-09-06T00:01:00.000Z',
        expiresInSeconds: 60,
        method: 'GET',
        url: 'https://objects.example.test/download',
      }),
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn<NonNullable<ArtifactStore['close']>>(),
    getStream: vi.fn<NonNullable<ArtifactStore['getStream']>>(),
    ...storeOverrides,
  } satisfies ArtifactStore;
  return { authorization, database, store };
}

export function context(
  overrides: Partial<Parameters<ArtifactService['beginUpload']>[0]> = {},
) {
  return {
    actor,
    routeWorkspaceId: workspaceId,
    ...overrides,
  };
}

export const uploadRequest = Object.freeze({
  byteLength: 4,
  mediaType: 'application/octet-stream',
  sha256: 'a'.repeat(64),
});

export function service(
  deps: ArtifactServiceDependencies,
  now = '2026-09-06T00:00:00.000Z',
) {
  return new ArtifactService(deps, {
    maxObjectBytes: 100,
    now: () => new Date(now),
  });
}
