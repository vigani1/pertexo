import { describe, expect, it, vi } from 'vitest';

import { eraseArtifact } from '../../src/lifecycle/artifacts/erase.js';

const target = { artifactId: 'artifact', workspaceId: 'workspace' };

describe('erasing an artifact from the store', () => {
  it('reports it erased once the store no longer has it', async () => {
    const store = {
      delete: vi.fn().mockResolvedValue(undefined),
      head: vi.fn().mockResolvedValue(null),
    };

    await expect(
      eraseArtifact(store, target, { timeoutMs: 1_000 }),
    ).resolves.toBe(true);
  });

  it('reports it not erased while the store still has the bytes', async () => {
    const store = {
      delete: vi.fn().mockResolvedValue(undefined),
      head: vi.fn().mockResolvedValue({ size: 1 }),
    };

    await expect(
      eraseArtifact(store, target, { timeoutMs: 1_000 }),
    ).resolves.toBe(false);
  });

  const hanging = (input: Readonly<{ signal?: AbortSignal }>) =>
    new Promise<void>((_resolve, reject) => {
      input.signal?.addEventListener('abort', () => {
        reject(input.signal?.reason as Error);
      });
    });

  it('cuts a store that hangs off at the deadline', async () => {
    const store = { delete: vi.fn(hanging), head: vi.fn() };

    await expect(
      eraseArtifact(store, target, { timeoutMs: 5 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(store.head).not.toHaveBeenCalled();
  });

  it('lets the caller abort before the deadline', async () => {
    const controller = new AbortController();
    const store = { delete: vi.fn(hanging), head: vi.fn() };
    const reason = new Error('shutting down');

    const erasing = eraseArtifact(store, target, {
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    controller.abort(reason);

    await expect(erasing).rejects.toBe(reason);
  });
});
