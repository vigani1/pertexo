import type { WorkflowGraphContract } from '@pertexo/contracts';
import { describe, expect, it, vi } from 'vitest';

import { addDefinitionNode } from '@/features/workflow-editor/model/graph/commands';
import {
  createEditorStore,
  shownConflict,
} from '@/features/workflow-editor/model/state/store';
import { createSaveCoordinator } from '@/features/workflow-editor/model/persistence/save-coordinator';

import type { WorkflowDraftSnapshot } from '@/features/workflow-editor/data/workflow-editor.api';
import { bareSetDefinition as definition } from '../../../support/fixtures/workflow-editor';

const etagA = `"draft.${'a'.repeat(43)}"`;
const etagB = `"draft.${'b'.repeat(43)}"`;

function emptyGraph(): WorkflowGraphContract {
  return { nodes: [], edges: [], settings: {} };
}

function snapshot(
  graph: WorkflowGraphContract,
  etag: string,
  revision: number,
): WorkflowDraftSnapshot {
  return {
    etag,
    draft: {
      workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      revision,
      graph,
      compatibility: {
        compatible: true,
        fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
        issues: [],
      },
      updatedAt: '2026-09-14T10:00:00.000Z',
    },
  };
}

describe('workflow editor save coordinator', () => {
  it('saves again by itself once a rate limit’s wait is over', async () => {
    vi.useFakeTimers();
    try {
      const store = createEditorStore({
        graph: emptyGraph(),
        etag: etagA,
        revision: 1,
      });
      const limited = Object.assign(new Error('rate limited'), {
        status: 429,
      });
      const save = vi
        .fn<(graph: WorkflowGraphContract) => Promise<WorkflowDraftSnapshot>>()
        .mockRejectedValueOnce(limited)
        .mockImplementation((graph) =>
          Promise.resolve(snapshot(graph, etagB, 2)),
        );
      const coordinator = createSaveCoordinator(store, {
        save,
        reload: vi.fn(),
        isConflict: () => false,
        isUncertain: () => false,
        retryAfterMs: (error) => (error === limited ? 3_000 : undefined),
        message: () => 'Too many saves in a short time. Saving again shortly.',
      });
      const one = addDefinitionNode(
        emptyGraph(),
        definition,
        { x: 0, y: 0 },
        'a',
      );
      store.getState().transact(one);
      await coordinator.flush();
      expect(store.getState().save.status).toBe('failed');
      await vi.advanceTimersByTimeAsync(2_900);
      expect(save).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(save).toHaveBeenCalledTimes(2);
      expect(store.getState().save.status).toBe('clean');
      coordinator.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  // A wait shorter than the 1 s save debounce still waits the debounce; a
  // longer one than a minute is cut to a minute.
  it.each([
    { wait: 100, before: 900, resumesBy: 1_000 },
    { wait: 300_000, before: 59_900, resumesBy: 60_000 },
  ])(
    'saves again after a rate limit asks for $wait ms within its bounds',
    async ({ wait, before, resumesBy }) => {
      vi.useFakeTimers();
      try {
        const store = createEditorStore({
          graph: emptyGraph(),
          etag: etagA,
          revision: 1,
        });
        const limited = new Error('rate limited');
        const save = vi
          .fn<
            (graph: WorkflowGraphContract) => Promise<WorkflowDraftSnapshot>
          >()
          .mockRejectedValueOnce(limited)
          .mockImplementation((graph) =>
            Promise.resolve(snapshot(graph, etagB, 2)),
          );
        const coordinator = createSaveCoordinator(store, {
          save,
          reload: vi.fn(),
          isConflict: () => false,
          isUncertain: () => false,
          retryAfterMs: (error) => (error === limited ? wait : undefined),
          message: () => 'Too many saves in a short time.',
        });
        store
          .getState()
          .transact(
            addDefinitionNode(emptyGraph(), definition, { x: 0, y: 0 }, 'a'),
          );
        await coordinator.flush();
        await vi.advanceTimersByTimeAsync(before);
        expect(save).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(resumesBy - before);
        expect(save).toHaveBeenCalledTimes(2);
        expect(store.getState().save.status).toBe('clean');
        coordinator.destroy();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('keeps edits made during a save dirty and serializes a second save', async () => {
    const store = createEditorStore({
      graph: emptyGraph(),
      etag: etagA,
      revision: 1,
    });
    const saves: WorkflowGraphContract[] = [];
    let resolveFirst:
      ((value: ReturnType<typeof snapshot>) => void) | undefined;
    const firstSave = new Promise<ReturnType<typeof snapshot>>((resolve) => {
      resolveFirst = resolve;
    });
    const save = vi.fn(async (graph: WorkflowGraphContract) => {
      saves.push(graph);
      if (saves.length === 1) return firstSave;
      return snapshot(graph, etagB, 3);
    });
    const coordinator = createSaveCoordinator(store, {
      save,
      reload: vi.fn(),
      isConflict: () => false,
      isUncertain: () => false,
      retryAfterMs: () => undefined,
      message: () => 'failed',
    });
    const one = addDefinitionNode(
      emptyGraph(),
      definition,
      { x: 0, y: 0 },
      'a',
    );
    store.getState().transact(one);
    const flushing = coordinator.flush();
    const two = addDefinitionNode(one, definition, { x: 100, y: 0 }, 'b');
    store.getState().transact(two);
    resolveFirst?.(snapshot(one, etagB, 2));
    await flushing;
    expect(saves).toEqual([one, two]);
    expect(store.getState().save.status).toBe('clean');
    expect(store.getState().graph).toBe(two);
    coordinator.destroy();
  });

  it('does not apply late results or recurse after the coordinator is destroyed', async () => {
    const store = createEditorStore({
      graph: emptyGraph(),
      etag: etagA,
      revision: 1,
    });
    const one = addDefinitionNode(
      emptyGraph(),
      definition,
      { x: 0, y: 0 },
      'a',
    );
    const two = addDefinitionNode(one, definition, { x: 100, y: 0 }, 'b');
    let resolveSave: ((value: ReturnType<typeof snapshot>) => void) | undefined;
    const pendingSave = new Promise<ReturnType<typeof snapshot>>((resolve) => {
      resolveSave = resolve;
    });
    const save = vi.fn().mockReturnValue(pendingSave);
    const coordinator = createSaveCoordinator(store, {
      save,
      reload: vi.fn(),
      isConflict: () => false,
      isUncertain: () => false,
      retryAfterMs: () => undefined,
      message: () => 'failed',
    });

    store.getState().transact(one);
    const flushing = coordinator.flush();
    store.getState().transact(two);
    coordinator.destroy();
    resolveSave?.(snapshot(one, etagB, 2));
    await flushing;

    expect(save).toHaveBeenCalledTimes(1);
    expect(store.getState().graph).toBe(two);
    expect(store.getState().etag).toBe(etagA);
    expect(store.getState().revision).toBe(1);
  });

  it('stops autosave on conflict and preserves both local and remote graphs', async () => {
    const local = addDefinitionNode(
      emptyGraph(),
      definition,
      { x: 0, y: 0 },
      'local',
    );
    const remote = addDefinitionNode(
      emptyGraph(),
      definition,
      { x: 0, y: 0 },
      'remote',
    );
    const store = createEditorStore({
      graph: emptyGraph(),
      etag: etagA,
      revision: 1,
    });
    store.getState().transact(local);
    const coordinator = createSaveCoordinator(store, {
      save: vi.fn().mockRejectedValue(new Error('conflict')),
      reload: vi.fn().mockResolvedValue(snapshot(remote, etagB, 2)),
      isConflict: () => true,
      isUncertain: () => false,
      retryAfterMs: () => undefined,
      message: () => 'failed',
    });
    await coordinator.flush();
    expect(store.getState().save.status).toBe('conflict');
    expect(shownConflict(store.getState())).toEqual({
      local,
      remote,
      remoteEtag: etagB,
      remoteRevision: 2,
    });
    store.getState().keepMine();
    expect(store.getState().graph).toBe(local);
    expect(store.getState().etag).toBe(etagB);
    expect(store.getState().save.status).toBe('dirty');
    expect(shownConflict(store.getState())).toBeNull();
    coordinator.destroy();
  });
});

describe('workflow editor conflicts and uncertain saves', () => {
  it('accepts a retried save whose first attempt landed after all', async () => {
    const local = addDefinitionNode(
      emptyGraph(),
      definition,
      { x: 0, y: 0 },
      'local',
    );
    const store = createEditorStore({
      graph: emptyGraph(),
      etag: etagA,
      revision: 1,
    });
    store.getState().transact(local);
    const coordinator = createSaveCoordinator(store, {
      save: vi.fn().mockRejectedValue(new Error('stale etag')),
      reload: vi.fn().mockResolvedValue(snapshot(local, etagB, 2)),
      isConflict: () => true,
      isUncertain: () => false,
      retryAfterMs: () => undefined,
      message: () => 'failed',
    });
    await coordinator.flush();
    expect(store.getState().save.status).toBe('clean');
    expect(store.getState().etag).toBe(etagB);
    expect(shownConflict(store.getState())).toBeNull();
    coordinator.destroy();
  });

  it('reconciles an uncertain committed save and bounds history to 100 transactions', async () => {
    const store = createEditorStore({
      graph: emptyGraph(),
      etag: etagA,
      revision: 1,
    });
    let latest = emptyGraph();
    for (let index = 0; index < 105; index += 1) {
      latest = {
        ...latest,
        settings: { maxRunDurationMs: index + 1 },
      };
      store.getState().transact(latest);
    }
    expect(store.getState().history.past).toHaveLength(100);
    const coordinator = createSaveCoordinator(store, {
      save: vi.fn().mockRejectedValue(new Error('lost response')),
      reload: vi.fn().mockResolvedValue(snapshot(latest, etagB, 2)),
      isConflict: () => false,
      isUncertain: () => true,
      retryAfterMs: () => undefined,
      message: () => 'uncertain',
    });
    await coordinator.flush();
    expect(store.getState().save.status).toBe('clean');
    expect(store.getState().etag).toBe(etagB);
    coordinator.destroy();
  });
});
