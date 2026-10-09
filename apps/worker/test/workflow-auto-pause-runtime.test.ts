import type {
  WorkflowTriggerPauseDecision,
  WorkflowTriggerPauseFoldStore,
} from '@pertexo/database/triggers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkflowAutoPauseRuntime } from '../src/workflows/auto-pause-runtime.js';

const decision = (paused: boolean): WorkflowTriggerPauseDecision => ({
  workspaceId: '11111111-1111-4111-8111-111111111111',
  workflowId: '22222222-2222-4222-8222-222222222222',
  consecutiveFailures: 10,
  paused,
});

function fakeStore(overrides: Partial<WorkflowTriggerPauseFoldStore> = {}) {
  return {
    checkReadiness: vi.fn(() => Promise.resolve()),
    foldPending: vi.fn(() =>
      Promise.resolve([] as readonly WorkflowTriggerPauseDecision[]),
    ),
    close: vi.fn(() => Promise.resolve()),
    ...overrides,
  } satisfies WorkflowTriggerPauseFoldStore;
}

function meter() {
  const add = vi.fn();
  return {
    add,
    meter: { createCounter: vi.fn(() => ({ add })) } as never,
  };
}

const options = (enforce: boolean) =>
  ({ enforce, foldBatchSize: 100, foldPollMillis: 1_000 }) as const;

describe('workflow auto-pause runtime', () => {
  afterEach(() => vi.useRealTimers());

  it('folds a burst in the configured mode, reporting each decision', async () => {
    const store = fakeStore({
      foldPending: vi
        .fn<WorkflowTriggerPauseFoldStore['foldPending']>()
        .mockResolvedValueOnce([decision(true)])
        .mockResolvedValue([]),
    });
    const counter = meter();
    const decided = vi.fn();
    const runtime = createWorkflowAutoPauseRuntime(
      store,
      options(true),
      { cycleFailed: vi.fn(), decided },
      counter.meter,
    );
    runtime.start();
    await runtime.checkReadiness();
    expect(store.checkReadiness).toHaveBeenCalledOnce();
    expect(store.foldPending).toHaveBeenNthCalledWith(
      1,
      100,
      true,
      expect.any(AbortSignal),
    );
    expect(decided).toHaveBeenCalledWith(decision(true));
    expect(counter.add).toHaveBeenCalledWith(1, { outcome: 'paused' });
    await runtime.close();
    expect(store.close).toHaveBeenCalledOnce();
  });

  it('only observes when not enforcing', async () => {
    const store = fakeStore({
      foldPending: vi
        .fn<WorkflowTriggerPauseFoldStore['foldPending']>()
        .mockResolvedValueOnce([decision(false)])
        .mockResolvedValue([]),
    });
    const counter = meter();
    const runtime = createWorkflowAutoPauseRuntime(
      store,
      options(false),
      { cycleFailed: vi.fn(), decided: vi.fn() },
      counter.meter,
    );
    runtime.start();
    await runtime.checkReadiness();
    expect(store.foldPending).toHaveBeenCalledWith(
      100,
      false,
      expect.any(AbortSignal),
    );
    expect(counter.add).toHaveBeenCalledWith(1, { outcome: 'would_pause' });
    await runtime.close();
  });

  it('is not ready when its store check or its cycle fails', async () => {
    const incompatible = createWorkflowAutoPauseRuntime(
      fakeStore({
        checkReadiness: vi.fn(() => Promise.reject(new Error('changed'))),
      }),
      options(true),
      { cycleFailed: vi.fn(), decided: vi.fn() },
      meter().meter,
    );
    incompatible.start();
    await expect(incompatible.checkReadiness()).rejects.toThrow(
      /store is not ready/u,
    );
    await incompatible.close();

    const cycleFailed = vi.fn();
    const failing = createWorkflowAutoPauseRuntime(
      fakeStore({
        foldPending: vi.fn(() => Promise.reject(new Error('database down'))),
      }),
      options(true),
      { cycleFailed, decided: vi.fn() },
      meter().meter,
    );
    failing.start();
    await expect(failing.checkReadiness()).rejects.toThrow(
      /latest cycle failed/u,
    );
    expect(cycleFailed).toHaveBeenCalled();
    await failing.close();
  });

  it('refuses readiness before starting and after closing', async () => {
    const runtime = createWorkflowAutoPauseRuntime(
      fakeStore(),
      options(true),
      { cycleFailed: vi.fn(), decided: vi.fn() },
      meter().meter,
    );
    await expect(runtime.checkReadiness()).rejects.toThrow(/not started/u);
    runtime.start();
    await runtime.close();
    await expect(runtime.checkReadiness()).rejects.toThrow(/closed/u);
  });
});
