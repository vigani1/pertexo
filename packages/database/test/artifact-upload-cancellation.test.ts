import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  withTenantScopedClient: vi.fn(),
}));

vi.mock('../src/platform/database-runtime.js', () => ({
  acquireDatabasePool: vi.fn(() => ({
    close: vi.fn().mockResolvedValue(undefined),
    pool: {},
  })),
}));

vi.mock('../src/tenant-access/transactions.js', () => ({
  withTenantScopedClient: seams.withTenantScopedClient,
}));

import { createArtifactUploadDatabase } from '../src/artifacts/upload.js';
import type { ArtifactRecord } from '../src/artifacts/store.js';

const workspaceId = randomUUID();
const actorId = randomUUID();
const artifactId = randomUUID();
const metadata = Object.freeze({
  byteLength: 17,
  mediaType: 'application/octet-stream',
  sha256: 'a'.repeat(64),
});
const pending = Object.freeze({
  ...metadata,
  id: artifactId,
  workspaceId,
  status: 'pending',
  expiresAt: new Date('2026-09-14T00:00:00.000Z'),
}) as ArtifactRecord;
const available = Object.freeze({
  ...pending,
  status: 'available',
}) as ArtifactRecord;
const config = {
  connectionString: 'postgresql://unused.test/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 1_000,
  max: 2,
  ownerRole: 'pertexo_owner',
} as const;

function input(signal: AbortSignal, verifyUpload?: () => Promise<void>) {
  return {
    actor: { actorId, workspaceId },
    expectedMetadata: metadata,
    identity: { artifactId, workspaceId },
    signal,
    ...(verifyUpload === undefined ? {} : { verifyUpload }),
  };
}

describe('artifact upload finalization cancellation', () => {
  beforeEach(() => {
    seams.withTenantScopedClient.mockReset();
    seams.withTenantScopedClient
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(available);
  });

  it('rejects a pre-aborted call without starting a transaction', async () => {
    const controller = new AbortController();
    const reason = new Error('pre-aborted finalization');
    controller.abort(reason);
    const database = createArtifactUploadDatabase(config);

    await expect(
      database.finalizeUpload(input(controller.signal)),
    ).rejects.toBe(reason);
    expect(seams.withTenantScopedClient).not.toHaveBeenCalled();
  });

  it('forwards the signal into both short transactions', async () => {
    const controller = new AbortController();
    const database = createArtifactUploadDatabase(config);

    await expect(
      database.finalizeUpload(input(controller.signal)),
    ).resolves.toBe(available);
    expect(seams.withTenantScopedClient).toHaveBeenCalledTimes(2);
    expect(seams.withTenantScopedClient.mock.calls[0]?.[3]).toEqual({
      signal: controller.signal,
    });
    expect(seams.withTenantScopedClient.mock.calls[1]?.[3]).toEqual({
      signal: controller.signal,
    });
  });

  it('does not begin finalization when verification aborts and then resolves', async () => {
    const controller = new AbortController();
    const reason = new Error('aborted after object verification');
    const database = createArtifactUploadDatabase(config);

    await expect(
      database.finalizeUpload(
        input(controller.signal, () => {
          controller.abort(reason);
          return Promise.resolve();
        }),
      ),
    ).rejects.toBe(reason);
    expect(seams.withTenantScopedClient).toHaveBeenCalledOnce();
  });

  it('propagates cancellation during either database phase', async () => {
    const firstRead = Promise.withResolvers<ArtifactRecord>();
    seams.withTenantScopedClient.mockReset();
    seams.withTenantScopedClient.mockReturnValueOnce(firstRead.promise);
    const firstController = new AbortController();
    const firstReason = new Error('abort first read');
    const database = createArtifactUploadDatabase(config);
    const first = database.finalizeUpload(input(firstController.signal));
    const firstRejection = expect(first).rejects.toBe(firstReason);
    firstController.abort(firstReason);
    firstRead.reject(firstReason);
    await firstRejection;

    const finalUpdate = Promise.withResolvers<ArtifactRecord>();
    seams.withTenantScopedClient.mockReset();
    seams.withTenantScopedClient
      .mockResolvedValueOnce(pending)
      .mockReturnValueOnce(finalUpdate.promise);
    const finalController = new AbortController();
    const finalReason = new Error('abort final update');
    const second = database.finalizeUpload(input(finalController.signal));
    const secondRejection = expect(second).rejects.toBe(finalReason);
    await vi.waitFor(() => {
      expect(seams.withTenantScopedClient).toHaveBeenCalledTimes(2);
    });
    finalController.abort(finalReason);
    finalUpdate.reject(finalReason);
    await secondRejection;
  });
});
