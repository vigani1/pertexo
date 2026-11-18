import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ArtifactApiConflictError,
  ArtifactService,
  ArtifactApiNotFoundError,
  ArtifactApiUnavailableError,
  ArtifactUploadDeadlineError,
} from '../../src/artifacts/index.js';
import {
  artifactId,
  record,
  dependencies,
  context,
  service,
  uploadRequest,
} from './artifact-transfer-service.fixture.js';
import { ArtifactIntegrityError } from '@pertexo/artifact-store/server';
import { ArtifactUploadNotFoundError } from '@pertexo/core/artifacts';

function finalizing(store: Parameters<typeof dependencies>[1]) {
  return new ArtifactService(dependencies({}, store), {
    maxObjectBytes: 100,
    now: () => new Date('2026-09-06T00:00:00.000Z'),
  });
}

describe('ArtifactService', () => {
  // The real transfer tests own authorization, replay deadlines, the
  // download window, pending downloads, the size ceiling and finalize. What
  // stays needs the object store or the database to fail on cue, a deleted
  // artifact under a replayed key, or the clock at a signer boundary.

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
      service.finalizeUpload({ ...context(), artifactId }),
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
      service.finalizeUpload({ ...context(), artifactId }),
    ).rejects.toBeInstanceOf(ArtifactApiUnavailableError);
  });

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
    ['missing', null, ArtifactUploadNotFoundError],
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
        }),
      ).rejects.toBeInstanceOf(PublicError);
      expect(deps.store.validateDirectUpload).not.toHaveBeenCalled();
      expect(deps.database.finalizeUpload).not.toHaveBeenCalled();
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

  it('keeps the object store failure as the cause of a 503', async () => {
    const failure = new Error('bucket pertexo-artifacts does not exist');
    await expect(
      finalizing({
        validateDirectUpload: vi.fn().mockRejectedValue(failure),
      }).finalizeUpload({ ...context(), artifactId }),
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
        signal: disconnect.signal,
      }),
    ).rejects.toBe(reason);
  });
});
