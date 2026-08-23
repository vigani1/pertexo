import { randomUUID } from 'node:crypto';

import { jobIdForOutboxEvent } from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

import {
  createPreviewCleanupHandler,
  type PreviewCleanupStore,
} from '../src/execution/preview-cleanup-runtime.js';
import { createPreviewMaintenanceRuntime } from '../src/execution/preview-maintenance-runtime.js';

const workspaceId = randomUUID();
const previewRunId = randomUUID();
const outboxEventId = randomUUID();

function delivery() {
  return {
    data: {
      outboxEventId,
      previewRunId,
      schemaVersion: 1 as const,
      workspaceId,
    },
    name: 'sweep-expired-previews' as const,
    transport: {
      attemptsMade: 0,
      jobId: jobIdForOutboxEvent(outboxEventId),
    },
  };
}

function context(): { signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

describe('preview cleanup handler', () => {
  it('deletes each claimed object before completing metadata and preview cleanup', async () => {
    const firstArtifactId = randomUUID();
    const secondArtifactId = randomUUID();
    const artifactIds = [firstArtifactId, secondArtifactId];
    const order: string[] = [];
    const store: PreviewCleanupStore = {
      claim: () =>
        Promise.resolve({
          kind: 'claimed',
          artifacts: artifactIds.map((artifactId) => ({
            artifactId,
            workspaceId,
          })),
        }),
      completeArtifact: ({ artifactId }) => {
        order.push(`complete:${artifactId}`);
        return Promise.resolve();
      },
      finish: () => {
        order.push('finish');
        return Promise.resolve({ kind: 'completed' });
      },
    };
    const remove = vi.fn(({ artifactId }: { artifactId: string }) => {
      order.push(`delete:${artifactId}`);
      return Promise.resolve();
    });
    const head = vi.fn(({ artifactId }: { artifactId: string }) => {
      order.push(`head:${artifactId}`);
      return Promise.resolve(null);
    });

    await expect(
      createPreviewCleanupHandler(store, { delete: remove, head }).handle(
        delivery(),
        context(),
      ),
    ).resolves.toEqual({ kind: 'completed' });
    expect(order).toEqual([
      `delete:${firstArtifactId}`,
      `head:${firstArtifactId}`,
      `complete:${firstArtifactId}`,
      `delete:${secondArtifactId}`,
      `head:${secondArtifactId}`,
      `complete:${secondArtifactId}`,
      'finish',
    ]);
  });

  it('leaves durable metadata open when object deletion fails', async () => {
    const artifactId = randomUUID();
    const completeArtifact = vi.fn();
    const finish = vi.fn();
    const store: PreviewCleanupStore = {
      claim: () =>
        Promise.resolve({
          kind: 'claimed',
          artifacts: [{ artifactId, workspaceId }],
        }),
      completeArtifact,
      finish,
    };
    const failure = new Error('object store unavailable');

    await expect(
      createPreviewCleanupHandler(store, {
        delete: () => Promise.reject(failure),
        head: () => Promise.resolve(null),
      }).handle(delivery(), context()),
    ).rejects.toBe(failure);
    expect(completeArtifact).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it('leaves durable metadata open when object absence is not confirmed', async () => {
    const artifactId = randomUUID();
    const completeArtifact = vi.fn();
    const store: PreviewCleanupStore = {
      claim: () =>
        Promise.resolve({
          kind: 'claimed',
          artifacts: [{ artifactId, workspaceId }],
        }),
      completeArtifact,
      finish: vi.fn(),
    };
    await expect(
      createPreviewCleanupHandler(store, {
        delete: () => Promise.resolve(),
        head: () =>
          Promise.resolve({
            artifactId,
            byteLength: 1,
            mediaType: 'application/octet-stream',
            sha256: 'a'.repeat(64),
            workspaceId,
          }),
      }).handle(delivery(), context()),
    ).rejects.toThrow('artifact_delete_unconfirmed');
    expect(completeArtifact).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'duplicate' as const },
    {
      kind: 'rescheduled' as const,
      cleanupOutboxEventId: randomUUID(),
    },
  ])('does no object work for $kind claims', async (claim) => {
    const remove = vi.fn();
    const finish = vi.fn();
    const store: PreviewCleanupStore = {
      claim: () => Promise.resolve(claim),
      completeArtifact: vi.fn(),
      finish,
    };
    await expect(
      createPreviewCleanupHandler(store, {
        delete: remove,
        head: () => Promise.resolve(null),
      }).handle(delivery(), context()),
    ).resolves.toEqual(claim);
    expect(remove).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it('rejects a forged transport identity before durable work', async () => {
    const claim = vi.fn();
    const forged = delivery();
    forged.transport.jobId = jobIdForOutboxEvent(randomUUID());
    await expect(
      createPreviewCleanupHandler(
        {
          claim,
          completeArtifact: vi.fn(),
          finish: vi.fn(),
        },
        { delete: vi.fn(), head: vi.fn() },
      ).handle(forged, context()),
    ).rejects.toThrow('transport identity is invalid');
    expect(claim).not.toHaveBeenCalled();
  });
});

describe('preview cleanup runtime readiness', () => {
  it('fails before creating a consumer when the artifact store is unavailable', async () => {
    const failure = new Error('bucket unavailable');
    const closeStore = vi.fn().mockResolvedValue(undefined);
    const closeArtifacts = vi.fn();
    const consumerFactory = vi.fn();
    await expect(
      createPreviewMaintenanceRuntime(
        {
          artifactStore: {
            accessKeyId: 'key',
            bucket: 'preview-artifacts',
            endpoint: 'http://localhost:9090',
            forcePathStyle: true,
            maxObjectBytes: 1_024,
            region: 'us-east-1',
            requestTimeoutMs: 1_000,
            secretAccessKey: 'secret',
          },
          database: {
            connectionString: 'postgresql://worker:secret@localhost/pertexo',
            connectionTimeoutMillis: 1_000,
            idleTimeoutMillis: 1_000,
            max: 1,
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          },
          redisUrl: 'redis://localhost:6379/0',
        },
        {
          artifactStore: {
            checkReadiness: () => Promise.reject(failure),
            close: closeArtifacts,
            delete: vi.fn(),
            head: vi.fn(),
          },
          consumerFactory,
          cleanupStore: {
            claim: vi.fn(),
            close: closeStore,
            completeArtifact: vi.fn(),
            finish: vi.fn(),
          },
          reconciliationStore: { close: vi.fn(), reconcile: vi.fn() },
        },
      ),
    ).rejects.toBe(failure);
    expect(consumerFactory).not.toHaveBeenCalled();
    expect(closeStore).toHaveBeenCalledOnce();
    expect(closeArtifacts).toHaveBeenCalledOnce();
  });
});
