import type { WorkflowGraphContract } from '@pertexo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { WorkflowDraftSnapshot } from '@/features/workflow-editor/data/workflow-editor.api';
import { addDefinitionNode } from '@/features/workflow-editor/model/graph/commands';
import { createSaveCoordinator } from '@/features/workflow-editor/model/persistence/save-coordinator';
import {
  createEditorStore,
  shownConflict,
} from '@/features/workflow-editor/model/state/store';
import { bareSetDefinition as definition } from '../../../support/fixtures/workflow-editor';

const startEtag = `"draft.${'a'.repeat(43)}"`;
const nextEtag = `"draft.${'b'.repeat(43)}"`;
const dropped = new Error('The save never reached the server');
const empty = (): WorkflowGraphContract => ({
  nodes: [],
  edges: [],
  settings: {},
});

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

function storeWithUnsavedStep(saved: WorkflowGraphContract = empty()) {
  const store = createEditorStore({
    graph: saved,
    etag: startEtag,
    revision: 2,
  });
  store
    .getState()
    .transact(addDefinitionNode(saved, definition, { x: 1, y: 2 }, 'mine'));
  return store;
}

function coordinator(
  store: ReturnType<typeof createEditorStore>,
  save: (graph: WorkflowGraphContract) => Promise<WorkflowDraftSnapshot>,
  reload: () => Promise<WorkflowDraftSnapshot>,
) {
  return createSaveCoordinator(
    store,
    {
      save,
      reload,
      isConflict: () => false,
      isUncertain: (error) => error === dropped,
      retryAfterMs: () => undefined,
      message: () => 'Couldn’t save',
    },
    0,
  );
}

describe('a save the network lost, with nobody else editing', () => {
  it('saves again quietly when the server still holds the revision it started from', async () => {
    const saved = empty();
    const store = storeWithUnsavedStep(saved);
    const save = vi
      .fn<(graph: WorkflowGraphContract) => Promise<WorkflowDraftSnapshot>>()
      .mockRejectedValueOnce(dropped)
      .mockImplementation((graph) =>
        Promise.resolve(snapshot(graph, nextEtag, 3)),
      );
    await coordinator(store, save, () =>
      Promise.resolve(snapshot(saved, startEtag, 2)),
    ).flush();
    expect(shownConflict(store.getState())).toBeNull();
    await vi.waitFor(() => {
      expect(store.getState().save.status).toBe('clean');
    });
    expect(store.getState().revision).toBe(3);
    expect(store.getState().graph.nodes.map(({ id }) => id)).toEqual(['mine']);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('accepts the save when the lost answer hid a save that landed', async () => {
    const store = storeWithUnsavedStep();
    const mine = store.getState().graph;
    await coordinator(
      store,
      () => Promise.reject(dropped),
      () => Promise.resolve(snapshot(mine, nextEtag, 3)),
    ).flush();
    expect(shownConflict(store.getState())).toBeNull();
    expect(store.getState().save.status).toBe('clean');
    expect(store.getState().revision).toBe(3);
  });

  it('still reports a conflict when another save really changed the draft', async () => {
    const store = storeWithUnsavedStep();
    const theirs = addDefinitionNode(
      empty(),
      definition,
      { x: 5, y: 5 },
      'theirs',
    );
    await coordinator(
      store,
      () => Promise.reject(dropped),
      () => Promise.resolve(snapshot(theirs, nextEtag, 3)),
    ).flush();
    expect(store.getState().save.status).toBe('conflict');
    expect(shownConflict(store.getState())?.remoteRevision).toBe(3);
    expect(store.getState().graph.nodes.map(({ id }) => id)).toEqual(['mine']);
  });

  it('stays unsure, with the edit kept, while the draft can’t be read back', async () => {
    const store = storeWithUnsavedStep();
    await coordinator(
      store,
      () => Promise.reject(dropped),
      () => Promise.reject(dropped),
    ).flush();
    expect(store.getState().save.status).toBe('uncertain');
    expect(shownConflict(store.getState())).toBeNull();
    expect(store.getState().graph.nodes.map(({ id }) => id)).toEqual(['mine']);
  });
});
