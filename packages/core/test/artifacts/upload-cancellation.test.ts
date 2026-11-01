import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  withTenantScopedClient: vi.fn(),
}));

vi.mock('../../../database/dist/platform/pool/runtime.js', () => ({
  acquireDatabasePool: vi.fn(() => ({
    close: vi.fn().mockResolvedValue(undefined),
    pool: {},
  })),
}));

vi.mock('../../../database/dist/tenant-access/transactions.js', () => ({
  withTenantScopedClient: seams.withTenantScopedClient,
}));

import { createArtifactUploadStore } from '../../src/artifacts/uploads/store.js';
import type { ArtifactRecord } from '../../src/artifacts/contract.js';

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
    const database = createArtifactUploadStore(config);

    await expect(
      database.finalizeUpload(input(controller.signal)),
    ).rejects.toBe(reason);
    expect(seams.withTenantScopedClient).not.toHaveBeenCalled();
  });

  it('does not begin finalization when verification aborts and then resolves', async () => {
    const controller = new AbortController();
    const reason = new Error('aborted after object verification');
    const database = createArtifactUploadStore(config);

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
});
