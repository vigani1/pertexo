import { randomUUID } from 'node:crypto';

import { jobIdForOutboxEvent } from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

import {
  createPreviewCleanupHandler,
  type PreviewCleanupStore,
} from '../src/execution/preview-cleanup-runtime.js';

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

    await expect(
      createPreviewCleanupHandler(store, { delete: remove }).handle(
        delivery(),
        context(),
      ),
    ).resolves.toEqual({ kind: 'completed' });
    expect(order).toEqual([
      `delete:${firstArtifactId}`,
      `complete:${firstArtifactId}`,
      `delete:${secondArtifactId}`,
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
      }).handle(delivery(), context()),
    ).rejects.toBe(failure);
    expect(completeArtifact).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
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
      createPreviewCleanupHandler(store, { delete: remove }).handle(
        delivery(),
        context(),
      ),
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
        { delete: vi.fn() },
      ).handle(forged, context()),
    ).rejects.toThrow('transport identity is invalid');
    expect(claim).not.toHaveBeenCalled();
  });
});
