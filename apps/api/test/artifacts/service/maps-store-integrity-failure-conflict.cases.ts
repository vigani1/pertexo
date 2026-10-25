import { randomUUID } from 'node:crypto';
import { ArtifactIntegrityError } from '@pertexo/artifact-store';
import {
  ArtifactQuotaExceededError,
  ArtifactUploadConflictError,
  ArtifactUploadIdempotencyConflictError,
  ArtifactUploadNotFoundError,
} from '@pertexo/database/runs';
import { expect, it, vi } from 'vitest';
import {
  ArtifactApiConflictError,
  ArtifactApiNotFoundError,
  ArtifactApiUnavailableError,
  ArtifactService,
  ArtifactUploadDeadlineError,
} from '../../../src/artifacts/index.js';

import {
  artifactId,
  record,
  dependencies,
  context,
  uploadRequest,
  service,
} from './fixture.js';

export function registerMapsStoreIntegrityFailureConflict(): void {
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
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
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
}
