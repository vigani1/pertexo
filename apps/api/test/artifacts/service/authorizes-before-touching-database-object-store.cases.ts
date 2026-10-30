import { randomUUID } from 'node:crypto';

import { expect, it, vi } from 'vitest';
import {
  ArtifactApiConflictError,
  ArtifactService,
  ArtifactUploadTooLargeError,
  type ArtifactDependencies,
} from '../../../src/artifacts/index.js';
import {
  AuthorizationError,
  type WorkspaceAccess,
} from '../../../src/authorization/index.js';
import {
  workspaceId,
  actorId,
  artifactId,
  record,
  dependencies,
  context,
  service,
} from './fixture.js';

export function registerAuthorizesBeforeTouchingDatabaseObjectStore(): void {
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
    ).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'auth.forbidden',
    });
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

  it.each([
    ['missing membership', undefined],
    [
      'inactive membership',
      {
        actorId,
        workspaceId,
        role: 'owner',
        membershipStatus: 'removed',
        workspaceStatus: 'active',
      },
    ],
    [
      'suspended workspace',
      {
        actorId,
        workspaceId,
        role: 'owner',
        membershipStatus: 'active',
        workspaceStatus: 'suspended',
      },
    ],
    [
      'lost upload capability',
      {
        actorId,
        workspaceId,
        role: 'viewer',
        membershipStatus: 'active',
        workspaceStatus: 'active',
      },
    ],
  ] satisfies readonly (readonly [string, WorkspaceAccess | undefined])[])(
    'preserves auth.forbidden when reauthorization finds %s',
    async (_case, secondAccess) => {
      let authorizationCalls = 0;
      let commitReached = false;
      const authorization = vi.fn(() => {
        authorizationCalls += 1;
        return Promise.resolve(
          authorizationCalls === 1
            ? {
                actorId,
                workspaceId,
                role: 'owner' as const,
                membershipStatus: 'active' as const,
                workspaceStatus: 'active' as const,
              }
            : secondAccess,
        );
      });
      const finalizeUpload = vi.fn(
        async (
          input: Parameters<
            ArtifactDependencies['database']['finalizeUpload']
          >[0],
        ) => {
          await input.verifyUpload?.();
          commitReached = true;
          return record({ status: 'available' });
        },
      );
      const deps = dependencies({ finalizeUpload }, {}, authorization);

      let thrown: unknown;
      try {
        await service(deps).finalizeUpload({
          ...context(),
          artifactId,
          request: {},
        });
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AuthorizationError);
      expect(thrown).toMatchObject({ code: 'auth.forbidden' });
      expect(authorization).toHaveBeenCalledTimes(2);
      expect(deps.store.validateDirectUpload).toHaveBeenCalledOnce();
      expect(finalizeUpload).toHaveBeenCalledOnce();
      expect(commitReached).toBe(false);
    },
  );

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
}
