import type {
  WorkspaceInboxChange,
  WorkspaceInboxFoldStore,
} from '@pertexo/database/inbox';
import type { WorkspaceInboxHintPublisher } from '@pertexo/queue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkspaceInboxRuntime } from '../../src/notifications/inbox-runtime.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const options = {
  foldBatchSize: 100,
  foldPollMillis: 1_000,
} as const;

function change(revision: string): WorkspaceInboxChange {
  return { workspaceId, revision };
}

function fakeStore(overrides: Partial<WorkspaceInboxFoldStore> = {}) {
  return {
    checkReadiness: vi.fn(() => Promise.resolve()),
    foldPending: vi.fn(() =>
      Promise.resolve([] as readonly WorkspaceInboxChange[]),
    ),
    close: vi.fn(() => Promise.resolve()),
    ...overrides,
  } satisfies WorkspaceInboxFoldStore;
}

function fakePublisher(
  publish: WorkspaceInboxHintPublisher['publish'] = () =>
    Promise.resolve({ receivers: 1 }),
) {
  return {
    publish: vi.fn(publish),
    close: vi.fn(() => Promise.resolve()),
  } satisfies WorkspaceInboxHintPublisher;
}

const diagnostics = () => ({ cycleFailed: vi.fn(), hintFailed: vi.fn() });

describe('workspace inbox runtime', () => {
  afterEach(() => vi.useRealTimers());

  it('folds a burst back to back, hints each change, then idles', async () => {
    vi.useFakeTimers();
    const store = fakeStore({
      foldPending: vi
        .fn<WorkspaceInboxFoldStore['foldPending']>()
        .mockResolvedValueOnce([change('1')])
        .mockResolvedValueOnce([change('2')])
        .mockResolvedValue([]),
    });
    const publisher = fakePublisher();
    const runtime = createWorkspaceInboxRuntime(
      store,
      publisher,
      options,
      diagnostics(),
    );
    try {
      runtime.start();
      await expect(runtime.checkReadiness()).resolves.toBeUndefined();
      expect(store.checkReadiness).toHaveBeenCalledOnce();
      expect(store.foldPending).toHaveBeenCalledTimes(3);
      expect(store.foldPending).toHaveBeenCalledWith(
        100,
        expect.any(AbortSignal),
      );
      expect(publisher.publish.mock.calls).toEqual([
        [change('1')],
        [change('2')],
      ]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(store.foldPending).toHaveBeenCalledTimes(4);
    } finally {
      await runtime.close();
    }
    expect(store.close).toHaveBeenCalledOnce();
    expect(publisher.close).toHaveBeenCalledOnce();
  });

  it('never runs commands that fail the startup compatibility check', async () => {
    vi.useFakeTimers();
    const store = fakeStore({
      checkReadiness: vi
        .fn<WorkspaceInboxFoldStore['checkReadiness']>()
        .mockRejectedValueOnce(new Error('incompatible'))
        .mockResolvedValue(undefined),
    });
    const observed = diagnostics();
    const runtime = createWorkspaceInboxRuntime(
      store,
      fakePublisher(),
      options,
      observed,
    );
    try {
      runtime.start();
      await expect(runtime.checkReadiness()).rejects.toThrow(
        'Workspace inbox store is not ready',
      );
      expect(store.foldPending).not.toHaveBeenCalled();
      expect(observed.cycleFailed).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(runtime.checkReadiness()).resolves.toBeUndefined();
      expect(store.checkReadiness).toHaveBeenCalledTimes(2);
      expect(store.foldPending).toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it('reports a failed cycle until the next one succeeds', async () => {
    vi.useFakeTimers();
    const store = fakeStore({
      foldPending: vi
        .fn<WorkspaceInboxFoldStore['foldPending']>()
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockResolvedValue([]),
    });
    const runtime = createWorkspaceInboxRuntime(
      store,
      fakePublisher(),
      options,
      {
        cycleFailed: () => {
          throw new Error('diagnostics unavailable');
        },
        hintFailed: vi.fn(),
      },
    );
    try {
      runtime.start();
      await expect(runtime.checkReadiness()).rejects.toThrow(
        'Workspace inbox latest cycle failed',
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(runtime.checkReadiness()).resolves.toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it('keeps folding when a hint cannot be delivered', async () => {
    const store = fakeStore({
      foldPending: vi
        .fn<WorkspaceInboxFoldStore['foldPending']>()
        .mockResolvedValueOnce([change('5')])
        .mockResolvedValue([]),
    });
    const observed = diagnostics();
    const runtime = createWorkspaceInboxRuntime(
      store,
      fakePublisher(() => Promise.reject(new Error('redis unavailable'))),
      options,
      observed,
    );
    try {
      runtime.start();
      await expect(runtime.checkReadiness()).resolves.toBeUndefined();
      expect(observed.hintFailed).toHaveBeenCalledOnce();
      expect(observed.cycleFailed).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it('stops an in-flight fold on close and closes its resources once', async () => {
    let started!: () => void;
    const folding = new Promise<void>((resolve) => {
      started = resolve;
    });
    const store = fakeStore({
      foldPending: vi.fn(
        (_limit: number, signal?: AbortSignal) =>
          new Promise<readonly WorkspaceInboxChange[]>((_resolve, reject) => {
            started();
            signal?.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      ),
    });
    const publisher = fakePublisher();
    const observed = diagnostics();
    const runtime = createWorkspaceInboxRuntime(
      store,
      publisher,
      options,
      observed,
    );
    runtime.start();
    await folding;
    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    await expect(closing).resolves.toBeUndefined();
    expect(observed.cycleFailed).not.toHaveBeenCalled();
    expect(store.close).toHaveBeenCalledOnce();
    expect(publisher.close).toHaveBeenCalledOnce();
    await expect(runtime.checkReadiness()).rejects.toThrow(
      'Workspace inbox runtime is closed',
    );
  });

  it('reports every resource that fails to close', async () => {
    const store = fakeStore({
      close: vi.fn(() => Promise.reject(new Error('store'))),
    });
    const publisher = {
      publish: vi.fn(),
      close: vi.fn(() => Promise.reject(new Error('publisher'))),
    };
    const runtime = createWorkspaceInboxRuntime(
      store,
      publisher,
      options,
      diagnostics(),
    );
    await expect(runtime.close()).rejects.toBeInstanceOf(AggregateError);
  });
});
