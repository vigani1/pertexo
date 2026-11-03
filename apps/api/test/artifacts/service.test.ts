import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ArtifactApiConflictError,
  ArtifactService,
  ArtifactUploadTooLargeError,
  ArtifactApiNotFoundError,
  ArtifactApiUnavailableError,
  ArtifactUploadDeadlineError,
  type ArtifactDependencies,
} from '../../src/artifacts/index.js';
import {
  AuthorizationError,
  type WorkspaceAccess,
} from '../../src/authorization/index.js';
import {
  workspaceId,
  actorId,
  artifactId,
  record,
  dependencies,
  context,
  service,
  uploadRequest,
} from './service/fixture.js';
import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
} from '@pertexo/artifact-store';
import {
  ArtifactQuotaExceededError,
  ArtifactUploadConflictError,
  ArtifactUploadIdempotencyConflictError,
  ArtifactUploadNotFoundError,
} from '@pertexo/core/artifacts';

function finalizing(store: Parameters<typeof dependencies>[1]) {
  return new ArtifactService(dependencies({}, store), {
    maxObjectBytes: 100,
    now: () => new Date('2026-09-06T00:00:00.000Z'),
  });
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

  it.each([
    [new ArtifactQuotaExceededError(), ArtifactQuotaExceededError],
    [
      new ArtifactUploadIdempotencyConflictError(),
      ArtifactUploadIdempotencyConflictError,
    ],
    [
      new ArtifactUploadConflictError('reservation conflict'),
      ArtifactUploadConflictError,
    ],
    [new ArtifactUploadNotFoundError(), ArtifactUploadNotFoundError],
    [new Error('database unavailable'), ArtifactApiUnavailableError],
  ] as const)(
    'maps reservation database failures without exposing provider errors',
    async (databaseError, PublicError) => {
      const deps = dependencies({
        beginUpload: vi.fn().mockRejectedValue(databaseError),
      });

      await expect(
        service(deps).beginUpload({
          ...context(),
          request: uploadRequest,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(PublicError);
      expect(deps.store.beginDirectUpload).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['deleting', 'deleting'],
    ['deleted', 'deleted'],
  ] as const)(
    'rejects a %s upload replay without minting a capability',
    async (_case, status) => {
      const deps = dependencies({
        beginUpload: vi.fn().mockResolvedValue({
          artifact: record({ status }),
          replayed: true,
        }),
      });

      await expect(
        service(deps).beginUpload({
          ...context(),
          request: uploadRequest,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(ArtifactApiConflictError);
      expect(deps.store.beginDirectUpload).not.toHaveBeenCalled();
    },
  );

  it.each([
    [59, false],
    [60, true],
    [900, true],
  ] as const)(
    'enforces the upload signer boundary at %i remaining seconds',
    async (remainingSeconds, shouldSign) => {
      const deps = dependencies({
        beginUpload: vi.fn().mockResolvedValue({
          artifact: record({
            expiresAt: new Date(
              Date.parse('2026-09-06T00:00:00.000Z') + remainingSeconds * 1_000,
            ),
          }),
          replayed: false,
        }),
      });
      const operation = service(deps).beginUpload({
        ...context(),
        request: uploadRequest,
        idempotencyKey: randomUUID(),
      });

      if (shouldSign) {
        await expect(operation).resolves.toMatchObject({ replayed: false });
        expect(deps.store.beginDirectUpload).toHaveBeenCalledWith(
          expect.objectContaining({ expiresInSeconds: remainingSeconds }),
        );
      } else {
        await expect(operation).rejects.toBeInstanceOf(
          ArtifactUploadDeadlineError,
        );
        expect(deps.store.beginDirectUpload).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ['missing', null, ArtifactApiNotFoundError],
    ['deleting', record({ status: 'deleting' }), ArtifactApiConflictError],
    ['deleted', record({ status: 'deleted' }), ArtifactApiConflictError],
  ] as const)(
    'rejects finalize for a %s artifact before object verification',
    async (_case, artifact, PublicError) => {
      const deps = dependencies({
        getForUpload: vi.fn().mockResolvedValue(artifact),
      });

      await expect(
        service(deps).finalizeUpload({
          ...context(),
          artifactId,
          request: {},
        }),
      ).rejects.toBeInstanceOf(PublicError);
      expect(deps.store.validateDirectUpload).not.toHaveBeenCalled();
      expect(deps.database.finalizeUpload).not.toHaveBeenCalled();
    },
  );

  it('rejects an expired pending finalize before object verification', async () => {
    const deps = dependencies({
      getForUpload: vi
        .fn()
        .mockResolvedValue(
          record({ expiresAt: new Date('2026-09-06T00:00:00.000Z') }),
        ),
    });

    await expect(
      service(deps).finalizeUpload({
        ...context(),
        artifactId,
        request: {},
      }),
    ).rejects.toBeInstanceOf(ArtifactUploadDeadlineError);
    expect(deps.store.validateDirectUpload).not.toHaveBeenCalled();
    expect(deps.database.finalizeUpload).not.toHaveBeenCalled();
  });

  it.each(['pending', 'available'] as const)(
    'returns exact public metadata for a %s artifact',
    async (status) => {
      const selected = record({ status });
      const deps = dependencies({
        getMetadata: vi.fn().mockResolvedValue(selected),
      });

      const response = await service(deps).getMetadata({
        ...context(),
        artifactId,
      });

      expect(response).toEqual({
        byteLength: selected.byteLength,
        createdAt: selected.createdAt.toISOString(),
        expiresAt:
          status === 'pending' ? selected.expiresAt.toISOString() : null,
        id: selected.id,
        mediaType: selected.mediaType,
        sha256: selected.sha256,
        status,
        workspaceId: selected.workspaceId,
      });
      expect(response).not.toHaveProperty('storageKey');
      expect(response).not.toHaveProperty('purpose');
    },
  );

  it.each([
    ['missing', null],
    ['deleting', record({ status: 'deleting' })],
    ['deleted', record({ status: 'deleted' })],
  ] as const)('conceals %s artifact metadata', async (_case, artifact) => {
    const deps = dependencies({
      getMetadata: vi.fn().mockResolvedValue(artifact),
    });

    await expect(
      service(deps).getMetadata({ ...context(), artifactId }),
    ).rejects.toBeInstanceOf(ArtifactApiNotFoundError);
  });

  it('does not mint a download capability for a pending artifact', async () => {
    const deps = dependencies();

    await expect(
      service(deps).beginDownload({ ...context(), artifactId }),
    ).rejects.toBeInstanceOf(ArtifactApiNotFoundError);
    expect(deps.store.beginDirectDownload).not.toHaveBeenCalled();
  });

  it('maps a missing object during verification to a conflict', async () => {
    const deps = dependencies(
      {},
      {
        validateDirectUpload: vi
          .fn()
          .mockRejectedValue(new ArtifactNotFoundError()),
      },
    );

    await expect(
      service(deps).finalizeUpload({ ...context(), artifactId, request: {} }),
    ).rejects.toBeInstanceOf(ArtifactApiConflictError);
  });

  it('keeps the object store failure as the cause of a 503', async () => {
    const failure = new Error('bucket pertexo-artifacts does not exist');
    await expect(
      finalizing({
        validateDirectUpload: vi.fn().mockRejectedValue(failure),
      }).finalizeUpload({ ...context(), artifactId, request: {} }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof ArtifactApiUnavailableError && error.cause === failure,
    );
  });

  it('keeps the database failure as the cause of a 503', async () => {
    const failure = new Error('connection terminated unexpectedly');
    await expect(
      service(
        dependencies({ beginUpload: vi.fn().mockRejectedValue(failure) }),
      ).beginUpload({
        ...context(),
        request: uploadRequest,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof ArtifactApiUnavailableError && error.cause === failure,
    );
  });

  it('lets a client disconnect through instead of reporting a storage outage', async () => {
    const disconnect = new AbortController();
    disconnect.abort();
    const reason: unknown = disconnect.signal.reason;
    await expect(
      finalizing({
        validateDirectUpload: vi.fn().mockRejectedValue(reason),
      }).finalizeUpload({
        ...context(),
        artifactId,
        request: {},
        signal: disconnect.signal,
      }),
    ).rejects.toBe(reason);
  });
});
it('accepts the exact 10 MiB ceiling and refuses one byte over before reserving, even with a larger store', async () => {
  const maximum = 10485760;
  const deps = dependencies({
    beginUpload: vi.fn().mockResolvedValue({
      artifact: record({ byteLength: maximum }),
      replayed: false,
    }),
  });
  const instance = new ArtifactService(deps, {
    maxObjectBytes: 100 * 1024 * 1024,
    now: () => new Date('2026-09-06T00:00:00Z'),
  });
  await instance.beginUpload({
    ...context(),
    request: { ...uploadRequest, byteLength: maximum },
    idempotencyKey: randomUUID(),
  });
  expect(deps.database.beginUpload).toHaveBeenCalledOnce();
  await expect(
    instance.beginUpload({
      ...context(),
      request: { ...uploadRequest, byteLength: maximum + 1 },
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toBeInstanceOf(ArtifactUploadTooLargeError);
  expect(deps.database.beginUpload).toHaveBeenCalledOnce();
});
