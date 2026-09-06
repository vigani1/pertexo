import { randomUUID } from 'node:crypto';

import { ArtifactIntegrityError } from '@pertexo/artifact-store';
import { describe, expect, it, vi } from 'vitest';

import {
  ArtifactApiConflictError,
  ArtifactApiUnavailableError,
  ArtifactService,
  ArtifactUploadTooLargeError,
  type ArtifactDependencies,
  type ArtifactRecord,
  type ArtifactStore,
} from '../../src/artifacts/index.js';
import { createActorContext } from '../../src/workspaces/index.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const artifactId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const actor = createActorContext({
  actorId,
  sessionId,
  workspaceId,
  requestId: 'request-artifact-test',
});

function record(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
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

function dependencies(
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
): ArtifactDependencies {
  const database = {
    beginUpload: vi
      .fn()
      .mockResolvedValue({ artifact: record(), replayed: false }),
    getForUpload: vi.fn().mockResolvedValue(record()),
    finalizeUpload: vi.fn().mockResolvedValue(record({ status: 'available' })),
    getMetadata: vi.fn().mockResolvedValue(record()),
    ...databaseOverrides,
  };
  const store: ArtifactStore = {
    beginDirectUpload: vi.fn().mockResolvedValue({
      expiresAt: '2026-09-06T00:15:00.000Z',
      expiresInSeconds: 900,
      headers: {},
      method: 'PUT',
      url: 'https://objects.example.test/upload',
    }),
    validateDirectUpload: vi.fn().mockResolvedValue({
      artifactId,
      workspaceId,
      byteLength: 4,
      mediaType: 'application/octet-stream',
      sha256: 'a'.repeat(64),
    }),
    beginDirectDownload: vi.fn().mockResolvedValue({
      expiresAt: '2026-09-06T00:01:00.000Z',
      expiresInSeconds: 60,
      method: 'GET',
      url: 'https://objects.example.test/download',
    }),
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    ...storeOverrides,
  };
  return { authorization, database, store };
}

function context(
  overrides: Partial<Parameters<ArtifactService['beginUpload']>[0]> = {},
) {
  return {
    actor,
    routeWorkspaceId: workspaceId,
    ...overrides,
  };
}

describe('ArtifactService', () => {
  it('authorizes before touching the database or object store', async () => {
    const deps = dependencies({}, {}, () => Promise.resolve(undefined));
    const service = new ArtifactService(deps, {
      maxObjectBytes: 100,
      now: () => new Date('2026-09-06T00:00:00.000Z'),
    });

    await expect(
      service.beginUpload({
        ...context(),
        request: {
          byteLength: 4,
          mediaType: 'application/octet-stream',
          sha256: 'a'.repeat(64),
        },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(deps.database.beginUpload).not.toHaveBeenCalled();
    expect(deps.store.beginDirectUpload).not.toHaveBeenCalled();
  });

  it('rejects oversized declarations before reservation', async () => {
    const deps = dependencies();
    const service = new ArtifactService(deps, { maxObjectBytes: 3 });
    await expect(
      service.beginUpload({
        ...context(),
        request: {
          byteLength: 4,
          mediaType: 'application/octet-stream',
          sha256: 'a'.repeat(64),
        },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ArtifactUploadTooLargeError);
    expect(deps.database.beginUpload).not.toHaveBeenCalled();
  });

  it('signs a replay within the original deadline and never extends it', async () => {
    const deps = dependencies({
      beginUpload: vi
        .fn()
        .mockResolvedValue({ artifact: record(), replayed: true }),
    });
    const service = new ArtifactService(deps, {
      maxObjectBytes: 100,
      now: () => new Date('2026-09-06T00:00:01.000Z'),
    });
    const response = await service.beginUpload({
      ...context(),
      request: {
        byteLength: 4,
        mediaType: 'application/octet-stream',
        sha256: 'a'.repeat(64),
      },
      idempotencyKey: randomUUID(),
    });
    expect(response.replayed).toBe(true);
    expect(deps.store.beginDirectUpload).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInSeconds: 899 }),
    );
    expect(deps.store.beginDirectUpload).toHaveBeenCalledOnce();
  });

  it('does not mint a PUT capability for an already available replay', async () => {
    const deps = dependencies({
      beginUpload: vi.fn().mockResolvedValue({
        artifact: record({ status: 'available' }),
        replayed: true,
      }),
    });
    const service = new ArtifactService(deps, { maxObjectBytes: 100 });
    await expect(
      service.beginUpload({
        ...context(),
        request: {
          byteLength: 4,
          mediaType: 'application/octet-stream',
          sha256: 'a'.repeat(64),
        },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ArtifactApiConflictError);
    expect(deps.store.beginDirectUpload).not.toHaveBeenCalled();
  });

  it('rechecks authorization after dual-region verification before finalize', async () => {
    let calls = 0;
    const deps = dependencies({}, {}, () => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? {
              actorId,
              workspaceId,
              role: 'owner' as const,
              membershipStatus: 'active' as const,
              workspaceStatus: 'active' as const,
            }
          : undefined,
      );
    });
    const service = new ArtifactService(deps, {
      maxObjectBytes: 100,
      now: () => new Date('2026-09-06T00:00:00.000Z'),
    });
    await expect(
      service.finalizeUpload({
        ...context(),
        artifactId,
        request: {},
      }),
    ).rejects.toThrow();
    expect(deps.store.validateDirectUpload).toHaveBeenCalledOnce();
    expect(deps.database.finalizeUpload).not.toHaveBeenCalled();
  });

  it('returns an available artifact without revalidating the object', async () => {
    const deps = dependencies({
      getForUpload: vi.fn().mockResolvedValue(record({ status: 'available' })),
    });
    const service = new ArtifactService(deps, {
      maxObjectBytes: 100,
      now: () => new Date('2026-09-06T00:00:00.000Z'),
    });
    const response = await service.finalizeUpload({
      ...context(),
      artifactId,
      request: {},
    });
    expect(response.status).toBe('available');
    expect(deps.store.validateDirectUpload).not.toHaveBeenCalled();
  });

  it('issues exactly a sixty-second attachment download', async () => {
    const deps = dependencies({
      getMetadata: vi.fn().mockResolvedValue(record({ status: 'available' })),
    });
    const service = new ArtifactService(deps, {
      maxObjectBytes: 100,
      now: () => new Date('2026-09-06T00:00:00.000Z'),
    });
    await service.beginDownload({ ...context(), artifactId });
    expect(deps.store.beginDirectDownload).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInSeconds: 60 }),
    );
  });

  it('maps a store integrity failure to a conflict', async () => {
    const deps = dependencies(
      {},
      {
        validateDirectUpload: vi
          .fn()
          .mockRejectedValue(new ArtifactIntegrityError('bad checksum')),
      },
    );
    const service = new ArtifactService(deps, {
      maxObjectBytes: 100,
      now: () => new Date('2026-09-06T00:00:00.000Z'),
    });
    await expect(
      service.finalizeUpload({ ...context(), artifactId, request: {} }),
    ).rejects.toBeInstanceOf(ArtifactApiConflictError);
  });

  it('does not infer a store conflict from an arbitrary provider message', async () => {
    const deps = dependencies(
      {},
      {
        validateDirectUpload: vi
          .fn()
          .mockRejectedValue(new Error('upstream request size timeout')),
      },
    );
    const service = new ArtifactService(deps, {
      maxObjectBytes: 100,
      now: () => new Date('2026-09-06T00:00:00.000Z'),
    });
    await expect(
      service.finalizeUpload({ ...context(), artifactId, request: {} }),
    ).rejects.toBeInstanceOf(ArtifactApiUnavailableError);
  });
});
