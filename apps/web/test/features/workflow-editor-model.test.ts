import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { describe, expect, it, vi } from 'vitest';
import {
  addDefinitionNode,
  connectWorkflowNodes,
  moveWorkflowNode,
  projectWorkflowGraph,
  removeWorkflowNode,
  updateWorkflowNode,
} from '@/features/workflow-editor/model/graph-adapter';
import { createEditorStore } from '@/features/workflow-editor/model/editor.store';
import { createSaveCoordinator } from '@/features/workflow-editor/model/save-coordinator';
import {
  applyNumericScratch,
  numericScratchFor,
  schemaFields,
} from '@/features/workflow-editor/model/inspector-draft';
import type { WorkflowDraftSnapshot } from '@/features/workflow-editor/workflow-editor.api';

const etagA = `"draft-v1.${'a'.repeat(43)}"`;
const etagB = `"draft-v1.${'b'.repeat(43)}"`;

const definition = {
  schemaVersion: 1,
  definition: { key: 'core.set', version: 1 },
  family: 'transform',
  configVersion: 1,
  configSchema: { type: 'object', properties: {} },
  inputSchema: {},
  outputSchema: {},
  ports: { inputs: ['in'], outputs: ['out'] },
  credentialRequirements: [],
  connectionRequirements: [],
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: [],
  lifecycle: 'active',
  available: true,
  publishable: true,
} satisfies NodeDefinitionCatalogItem;

function emptyGraph(): WorkflowGraphContract {
  return { schemaVersion: 1, nodes: [], edges: [], settings: {} };
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
      schemaVersion: 1,
      graph,
      compatibility: {
        compatible: true,
        fingerprint: `wf-compat:v1:sha256:${'a'.repeat(64)}`,
        issues: [],
      },
      updatedAt: '2026-09-14T10:00:00.000Z',
    },
  };
}

describe('workflow editor model', () => {
  it('keeps numeric scratch textual until Apply and preserves unknown config fields', () => {
    const fields = schemaFields({
      type: 'object',
      required: ['requiredCount'],
      properties: {
        optionalCount: { type: 'number', title: 'Optional count' },
        requiredCount: { type: 'integer', title: 'Required count' },
      },
    });
    const config = {
      optionalCount: 4,
      requiredCount: 2,
      unknown: { preserved: true },
    };
    expect(numericScratchFor(config, fields)).toEqual({
      optionalCount: '4',
      requiredCount: '2',
    });
    expect(
      applyNumericScratch(config, fields, {
        optionalCount: '',
        requiredCount: '0',
      }),
    ).toEqual({
      config: { requiredCount: 0, unknown: { preserved: true } },
      errors: {},
    });
    expect(
      applyNumericScratch(config, fields, {
        optionalCount: '-2.5',
        requiredCount: '-3',
      }),
    ).toEqual({
      config: {
        optionalCount: -2.5,
        requiredCount: -3,
        unknown: { preserved: true },
      },
      errors: {},
    });
    expect(
      applyNumericScratch(config, fields, {
        optionalCount: '-',
        requiredCount: '1.5',
      }),
    ).toEqual({
      errors: {
        optionalCount: 'Optional count must be a valid number.',
        requiredCount: 'Required count must be a whole number.',
      },
    });
    expect(
      applyNumericScratch(config, fields, {
        optionalCount: '1',
        requiredCount: '',
      }),
    ).toEqual({ errors: { requiredCount: 'Required count is required.' } });
  });

  it('projects unsupported nodes without mutating or dropping their contract data', () => {
    const graph = addDefinitionNode(
      emptyGraph(),
      definition,
      { x: 10, y: 20 },
      'node-a',
    );
    const unsupported = updateWorkflowNode(graph, 'node-a', {
      label: 'Retained node',
      config: { nested: { value: 1 } },
    });
    const projection = projectWorkflowGraph(unsupported, []);
    expect(projection.nodes[0]?.data.unsupported).toBe(true);
    expect(projection.nodes[0]?.data.label).toBe('Retained node');
    expect(unsupported.nodes[0]?.config).toEqual({ nested: { value: 1 } });
  });

  it('preserves graph identity for cheap no-op transitions', () => {
    const graph = addDefinitionNode(
      emptyGraph(),
      definition,
      { x: 12, y: 24 },
      'node-a',
    );
    expect(moveWorkflowNode(graph, 'node-a', { x: 12, y: 24 })).toBe(graph);
    expect(moveWorkflowNode(graph, 'missing', { x: 1, y: 2 })).toBe(graph);
    expect(updateWorkflowNode(graph, 'missing', { label: 'ignored' })).toBe(
      graph,
    );
    expect(removeWorkflowNode(graph, 'missing')).toBe(graph);
  });

  it('adds, connects and removes nodes as one domain graph', () => {
    const first = addDefinitionNode(
      emptyGraph(),
      definition,
      { x: 0, y: 0 },
      'a',
    );
    const second = addDefinitionNode(first, definition, { x: 100, y: 0 }, 'b');
    const connected = connectWorkflowNodes(
      second,
      { source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' },
      'edge-a-b',
    );
    expect(connected?.edges).toHaveLength(1);
    expect(removeWorkflowNode(connected ?? second, 'a')).toEqual({
      ...second,
      nodes: [second.nodes[1]],
      edges: [],
    });
  });

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
    expect(store.getState().saveStatus).toBe('clean');
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
      message: () => 'failed',
    });
    await coordinator.flush();
    expect(store.getState().saveStatus).toBe('conflict');
    expect(store.getState().conflict).toEqual({
      local,
      remote,
      remoteEtag: etagB,
      remoteRevision: 2,
    });
    store.getState().acceptRemoteForReview();
    expect(store.getState().graph).toBe(remote);
    expect(store.getState().etag).toBe(etagB);
    expect(store.getState().saveStatus).toBe('clean');
    expect(store.getState().conflict).toEqual({
      local,
      remote,
      remoteEtag: etagB,
      remoteRevision: 2,
    });
    const reapplied = addDefinitionNode(
      store.getState().graph,
      definition,
      { x: 100, y: 0 },
      'reapplied',
    );
    store.getState().transact(reapplied);
    expect(store.getState().etag).toBe(etagB);
    expect(store.getState().conflict?.local).toBe(local);
    store.getState().dismissConflictComparison();
    expect(store.getState().conflict).toBeNull();
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
      message: () => 'uncertain',
    });
    await coordinator.flush();
    expect(store.getState().saveStatus).toBe('clean');
    expect(store.getState().etag).toBe(etagB);
    coordinator.destroy();
  });
});
